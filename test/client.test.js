import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { SlackError, connect, doctor, serveMcp } from "../index.js";
import { fakeSlack } from "./fake-slack.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const users = [
  { id: "U0000MAX", name: "max", real_name: "Max Power", profile: { display_name: "Max" } },
  { id: "U0000OLD", name: "max.old", real_name: "Max", profile: { display_name: "" }, deleted: true },
  { id: "U0000ME1", name: "me", real_name: "Me", profile: { display_name: "kinduff" } },
];
const channels = [
  { id: "C0000GEN", name: "general", is_private: false },
  { id: "G0000SEC", name: "secret", is_private: true },
];

const handlers = {
  "auth.test": () => ({ ok: true, user: "me", user_id: "U0000ME1" }),
  "chat.postMessage": (f) => ({ ok: true, ts: "1800000000.000200", channel: f.channel }),
  "chat.update": () => ({ ok: true }),
  "chat.delete": () => ({ ok: true }),
  "reactions.add": () => ({ ok: true }),
  "conversations.open": (f) => ({ ok: true, channel: { id: f.users.includes(",") ? "G0000GRP" : "D0000DM1" } }),
  "users.conversations": () => ({ ok: true, channels, response_metadata: { next_cursor: "" } }),
  "conversations.info": (f) => ({ ok: true, channel: f.channel.startsWith("D") ? { id: f.channel, is_im: true, user: "U0000MAX" } : { id: f.channel, name: "general" } }),
  "users.info": (f) => ({ ok: true, user: users.find((u) => u.id === f.user) }),
  "users.list": (f) => (f.cursor ? { ok: true, members: users.slice(2) } : { ok: true, members: users.slice(0, 2), response_metadata: { next_cursor: "page2" } }),
  "users.lookupByEmail": () => ({ ok: false, error: "users_not_found" }),
  "conversations.history": () => ({ ok: true, messages: [{ ts: "2", user: "U0000ME1", text: "new" }, { ts: "1", bot_id: "B01", text: "old", reply_count: 2 }] }),
  "search.messages": () => ({ ok: true, messages: { matches: [{ channel: { id: "C0000GEN", name: "general" }, ts: "1", user: "U0000MAX", username: "max", text: "deploy", permalink: "https://x" }] } }),
  "users.profile.get": () => ({ ok: true, profile: { status_text: "away", status_emoji: ":palm_tree:", status_expiration: 0 } }),
  "users.profile.set": () => ({ ok: true }),
  "channel.boom": () => ({ ok: false, error: "channel_not_found" }),
};

async function setup(t, opts = {}) {
  const fake = await fakeSlack({ handlers, ...opts });
  const slack = await connect({ port: fake.port, reconnectDelay: 50 });
  t.after(async () => {
    await slack.close();
    await fake.close();
  });
  return { fake, slack };
}

test("lists workspaces and knows which users are you", async (t) => {
  const { slack } = await setup(t);
  const ws = await slack.workspaces();
  assert.deepEqual(ws.map((w) => [w.id, w.name, w.userId, w.active, w.signedIn]), [
    ["T0000001", "Acme", "U0000ME1", true, true],
    ["T0000002", "Side Project", "U0000ME2", false, true],
  ]);
  assert.deepEqual(await slack.selfIds(), ["U0000ME1", "U0000ME2"]);
  assert.ok(slack.isSelf("U0000ME2"));
  assert.ok(!slack.isSelf("U0000MAX"));
});

test("api sends the page's token and _x_ params from inside the page, and returns only the body", async (t) => {
  const { fake, slack } = await setup(t);
  const body = await slack.api("auth.test");
  assert.deepEqual(body, { ok: true, user: "me", user_id: "U0000ME1" });
  assert.equal(fake.calls[0].fields.token, "xoxc-secret-1");
  assert.equal(fake.calls[0].query, "?_x_id=abc");
  assert.ok(!JSON.stringify(body).includes("xoxc"));
});

test("team picks the workspace by ID or name prefix", async (t) => {
  const { fake, slack } = await setup(t);
  await slack.api("auth.test", {}, { team: "T0000002" });
  await slack.api("auth.test", {}, { team: "side" });
  assert.deepEqual(fake.calls.map((c) => c.team), ["T0000002", "T0000002"]);
  await assert.rejects(slack.api("auth.test", {}, { team: "nope" }), { code: "unknown_team" });
});

test("errors are SlackErrors with the code and body", async (t) => {
  const { slack } = await setup(t);
  await assert.rejects(slack.api("channel.boom"), (e) => e instanceof SlackError && e.code === "channel_not_found" && e.body.error === "channel_not_found");
});

test("waits for the page's first API call before calling", async (t) => {
  const { fake, slack } = await setup(t, { templates: false });
  setTimeout(() => fake.setTemplates(true), 300);
  assert.equal((await slack.api("auth.test")).ok, true);
});

test("waits out a rate limit", async (t) => {
  let n = 0;
  const { slack } = await setup(t);
  handlers["flaky.method"] = () => (n++ ? { ok: true } : { ok: false, error: "ratelimited", retryAfter: 0.1 });
  t.after(() => delete handlers["flaky.method"]);
  assert.equal((await slack.api("flaky.method")).ok, true);
  assert.equal(n, 2);
});

test("objects in params go as JSON, empty ones are dropped", async (t) => {
  const { fake, slack } = await setup(t);
  await slack.postMessage("C0000GEN", "hi", { blocks: [{ type: "divider" }] });
  const { fields } = fake.calls.at(-1);
  assert.equal(fields.blocks, '[{"type":"divider"}]');
  assert.ok(!("thread_ts" in fields));
});

test("resolves channels by ID, #name, @person and user ID", async (t) => {
  const { slack } = await setup(t);
  assert.equal(await slack.resolveChannel("C0000GEN"), "C0000GEN");
  assert.equal(await slack.resolveChannel("#secret"), "G0000SEC");
  assert.equal(await slack.resolveChannel("general"), "C0000GEN");
  assert.equal(await slack.resolveChannel("@max"), "D0000DM1");
  assert.equal(await slack.resolveChannel("U0000MAX"), "D0000DM1");
  await assert.rejects(slack.resolveChannel("#nope"), { code: "channel_not_found" });
  await assert.rejects(slack.resolveChannel("@nobody"), { code: "user_not_found" });
});

test("userByName prefers active people, matches any name, and pages through users.list", async (t) => {
  const { fake, slack } = await setup(t);
  assert.equal((await slack.userByName("Max")).id, "U0000MAX");
  assert.equal((await slack.userByName("@kinduff")).id, "U0000ME1");
  assert.equal(fake.calls.filter((c) => c.method === "users.list").length, 2);
  await slack.userByName("max");
  assert.equal(fake.calls.filter((c) => c.method === "users.list").length, 2, "cached");
  assert.equal(await slack.userByEmail("x@y.z"), null);
});

test("posts, replies, edits, deletes and reacts", async (t) => {
  const { fake, slack } = await setup(t);
  assert.equal(await slack.postMessage("#general", "hi", { threadTs: "1" }), "1800000000.000200");
  await slack.reply({ channel: "C0000GEN", ts: "5", threadTs: null, team: "T0000002" }, "yo");
  await slack.updateMessage("C0000GEN", "5", "edited");
  await slack.deleteMessage("C0000GEN", "5");
  await slack.react("C0000GEN", "5", ":eyes:");
  const sent = fake.calls.filter((c) => c.method !== "users.conversations");
  assert.deepEqual(sent.map((c) => [c.method, c.team, c.fields.channel, c.fields.thread_ts ?? c.fields.ts ?? c.fields.timestamp]), [
    ["chat.postMessage", "T0000001", "C0000GEN", "1"],
    ["chat.postMessage", "T0000002", "C0000GEN", "5"],
    ["chat.update", "T0000001", "C0000GEN", "5"],
    ["chat.delete", "T0000001", "C0000GEN", "5"],
    ["reactions.add", "T0000001", "C0000GEN", "5"],
  ]);
  assert.equal(sent.at(-1).fields.name, "eyes");
});

test("opens DMs and group DMs", async (t) => {
  const { slack } = await setup(t);
  assert.equal(await slack.openDM("U0000MAX"), "D0000DM1");
  assert.equal(await slack.openDM(["U0000MAX", "U0000OLD"]), "G0000GRP");
});

test("reads history, search, names, places and status", async (t) => {
  const { slack } = await setup(t);
  const h = await slack.history("C0000GEN");
  assert.deepEqual(h.map((m) => [m.ts, m.user, m.bot, m.self, m.replies]), [["2", "U0000ME1", false, true, 0], ["1", "B01", true, false, 2]]);
  assert.equal((await slack.search("deploy"))[0].channelName, "general");
  assert.equal(await slack.userName("U0000MAX"), "Max");
  assert.equal(await slack.userName("U0000ZZZ"), "U0000ZZZ");
  assert.equal(await slack.place("C0000GEN"), "#general");
  assert.equal(await slack.place("D0000DM1"), "@Max");
  assert.deepEqual(await slack.getStatus(), { text: "away", emoji: ":palm_tree:", expiresAt: 0 });
  assert.equal((await slack.conversations()).length, 2);
});

test("uploads in Slack's two steps", async (t) => {
  const { fake, slack } = await setup(t);
  handlers["files.getUploadURLExternal"] = (f) => ({ ok: true, upload_url: `http://127.0.0.1:${fake.port}/upload/F01`, file_id: "F01", length: f.length });
  handlers["files.completeUploadExternal"] = (f) => ({ ok: true, files: [{ id: "F01", name: JSON.parse(f.files)[0].title, permalink: "https://files/F01" }], channel: f.channel_id });
  t.after(() => {
    delete handlers["files.getUploadURLExternal"];
    delete handlers["files.completeUploadExternal"];
  });
  const f = await slack.upload("C0000GEN", { data: "hello", filename: "a.txt", comment: "here" });
  assert.deepEqual(f, { id: "F01", name: "a.txt", permalink: "https://files/F01" });
  assert.deepEqual(fake.uploads, [{ url: "/upload/F01", body: "hello" }]);
  const done = fake.calls.find((c) => c.method === "files.completeUploadExternal").fields;
  assert.equal(done.channel_id, "C0000GEN");
  assert.equal(done.initial_comment, "here");
});

test("emits messages, edits, deletes and reactions with the self flag", async (t) => {
  const { fake, slack } = await setup(t);
  const seen = [];
  for (const kind of ["message", "edit", "delete", "reaction"]) slack.on(kind, (x) => seen.push([kind, x]));
  fake.push({ type: "message", team: "T0000001", channel: "C0000GEN", user: "U0000ME1", text: "mine", ts: "1" });
  fake.push({ type: "message", subtype: "message_changed", channel: "C0000GEN", message: { user: "U0000MAX", text: "b", ts: "2" }, previous_message: { text: "a" } });
  fake.push({ type: "message", subtype: "message_changed", channel: "C0000GEN", message: { user: "U0000MAX", text: "same", ts: "3" }, previous_message: { text: "same" } });
  fake.push({ type: "message", subtype: "message_deleted", channel: "C0000GEN", deleted_ts: "4", previous_message: { user: "U0000MAX", text: "gone" } });
  fake.push({ type: "reaction_added", user: "U0000MAX", reaction: "eyes", item: { type: "message", channel: "C0000GEN", ts: "1" }, item_user: "U0000ME1" });
  fake.push({ type: "user_typing", channel: "C0000GEN" });
  await sleep(100);
  assert.deepEqual(seen.map(([k, x]) => [k, x.ts, x.self]), [
    ["message", "1", true],
    ["edit", "2", false],
    ["delete", "4", false],
    ["reaction", "1", false],
  ]);
  assert.equal(seen[1][1].previousText, "a");
  assert.equal(seen[2][1].text, "gone");
  assert.equal(seen[3][1].added, true);
});

test("messages() yields new messages and ends on close", async (t) => {
  const fake = await fakeSlack({ handlers });
  t.after(() => fake.close());
  const slack = await connect({ port: fake.port });
  const got = [];
  const loop = (async () => {
    for await (const m of slack.messages()) got.push(m.text);
  })();
  await sleep(50);
  fake.push({ type: "message", channel: "C0000GEN", user: "U0000MAX", text: "one", ts: "1" });
  fake.push({ type: "message", channel: "C0000GEN", user: "U0000MAX", text: "two", ts: "2" });
  await sleep(100);
  await slack.close();
  await loop;
  assert.deepEqual(got, ["one", "two"]);
  await assert.rejects(slack.workspaces(), { code: "not_connected" });
});

test("reconnects after losing the page and keeps delivering", async (t) => {
  const { fake, slack } = await setup(t);
  const disconnected = once(slack, "disconnect");
  const reconnected = once(slack, "connect");
  fake.drop();
  await disconnected;
  await reconnected;
  const next = once(slack, "message");
  fake.push({ type: "message", channel: "C0000GEN", user: "U0000MAX", text: "back", ts: "9" });
  assert.equal((await next)[0].text, "back");
});

async function freePort() {
  const s = createServer().listen(0);
  await once(s, "listening");
  const { port } = s.address();
  s.close();
  return port;
}

test("connect explains what to do when nothing listens", async () => {
  await assert.rejects(connect({ port: await freePort() }), /remote-debugging-port=\d+, or pass \{ launch: true \}/);
});

test("doctor passes against a healthy page and names the broken link otherwise", async (t) => {
  const fake = await fakeSlack({ handlers });
  t.after(() => fake.close());
  const good = await doctor({ port: fake.port });
  assert.equal(good.ok, true);
  assert.deepEqual(good.checks.filter((c) => c.name !== "app").map((c) => [c.name, c.status]), [
    ["port", "ok"],
    ["page", "ok"],
    ["session", "ok"],
    ["api params", "ok"],
    ["auth Acme", "ok"],
    ["auth Side Project", "ok"],
  ]);
  const bad = await doctor({ port: await freePort() });
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.at(-1).name, "port");
  assert.ok(bad.checks.at(-1).hint);
});

test("MCP server lists tools and calls them", async (t) => {
  const fake = await fakeSlack({ handlers });
  t.after(() => fake.close());
  const input = new PassThrough();
  const output = new PassThrough();
  const server = serveMcp({ connectOptions: { port: fake.port }, input, output, log: () => {} });
  const replies = [];
  output.on("data", (d) => replies.push(...d.toString().trim().split("\n").map((l) => JSON.parse(l))));
  const call = async (id, method, params) => {
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    while (!replies.some((r) => r.id === id)) await sleep(10);
    return replies.find((r) => r.id === id);
  };
  assert.equal((await call(1, "initialize", {})).result.serverInfo.name, "slack-cdp");
  const names = (await call(2, "tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["slack_workspaces", "slack_conversations", "slack_history", "slack_search", "slack_send", "slack_react", "slack_inbox"]);
  assert.equal((await call(3, "tools/call", { name: "slack_send", arguments: { channel: "#general", text: "hi" } })).result.content[0].text, "sent at 1800000000.000200");
  fake.push({ type: "message", team: "T0000001", channel: "C0000GEN", user: "U0000MAX", text: "hey <@U0000ME1>", ts: "7" });
  const inbox = (await call(4, "tools/call", { name: "slack_inbox", arguments: { wait_s: 2 } })).result.content[0].text;
  assert.equal(inbox, "Acme #general (C0000GEN) [7] Max: hey @kinduff");
  assert.equal((await call(5, "nope")).error.code, -32601);
  input.end();
  await server.done;
});
