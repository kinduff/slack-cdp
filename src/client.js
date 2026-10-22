// A Slack client riding on the desktop app's own session over the DevTools port: Web API
// calls made inside the page, and the events the page receives on its websocket.
import { EventEmitter, on } from "node:events";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Session, findPage } from "./cdp.js";
import { apiExpression, workspacesExpression } from "./page.js";
import { deleteEvent, editEvent, messageEvent, parseFrame, reactionEvent } from "./events.js";
import { restartSlack } from "./app.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isSlackPage = (url) => url.startsWith("https://app.slack.com/");
const TEMPLATE_WAIT_S = 30;
const RATE_LIMIT_RETRIES = 3;
const DIRECTORY_TTL_MS = 5 * 60_000;

const TEAM_ID = /^[TE][A-Z0-9]{6,}$/;
const CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

export class SlackError extends Error {
  constructor(code, { retryAfter = null, body = null } = {}) {
    super(`slack: ${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

const message = (m, me) => {
  const user = m.user ?? m.bot_id ?? null;
  return {
    ts: m.ts,
    user,
    bot: !m.user && Boolean(m.bot_id),
    self: me.has(user),
    text: m.text ?? "",
    threadTs: m.thread_ts ?? null,
    replies: m.reply_count ?? 0,
    files: (m.files ?? []).map((f) => f.name ?? f.title ?? "file"),
  };
};

const conversation = (c) => ({
  id: c.id,
  name: c.name ?? null,
  user: c.user ?? null,
  im: Boolean(c.is_im),
  mpim: Boolean(c.is_mpim),
  private: Boolean(c.is_private),
});

const person = (u) => ({
  id: u.id,
  name: u.profile?.display_name || u.real_name || u.name,
  username: u.name,
  realName: u.real_name ?? u.profile?.real_name ?? null,
  email: u.profile?.email ?? null,
  bot: Boolean(u.is_bot),
  deleted: Boolean(u.deleted),
});

export class Slack extends EventEmitter {
  #opts;
  #session = null;
  #closed = false;
  #me = new Set();
  #workspaces = null;
  #names = new Map();
  #places = new Map();
  #directories = new Map();
  // True when connect() restarted Slack to open the port; close() then restarts it without.
  launched = false;

  constructor(opts) {
    super();
    this.#opts = opts;
  }

  // Attaches to a running Slack with the DevTools port open. With launch: true, restarts
  // Slack with the port first if it isn't open.
  static async connect({ host = "127.0.0.1", port = 9222, launch = false, reconnect = true, reconnectDelay = 5000 } = {}) {
    const slack = new Slack({ host, port, reconnect, reconnectDelay });
    if (!(await slack.#portOpen())) {
      if (!launch) throw new Error(`Slack isn't listening on ${host}:${port}; start it with --remote-debugging-port=${port}, or pass { launch: true }`);
      await restartSlack({ port, ready: () => slack.#portOpen() });
      slack.launched = true;
    }
    await slack.#attach();
    return slack;
  }

  get connected() {
    return this.#session !== null;
  }

  async #portOpen() {
    try {
      return Boolean(await findPage({ ...this.#opts, match: isSlackPage }));
    } catch {
      return false;
    }
  }

  async #attach() {
    const page = await findPage({ ...this.#opts, match: isSlackPage });
    if (!page) throw new Error("Slack page not found on the DevTools port");
    const session = await Session.open(page.webSocketDebuggerUrl);
    this.#session = session;
    try {
      this.#workspaces = await session.evaluate(workspacesExpression);
      this.#me = new Set(this.#workspaces.map((w) => w.userId).filter(Boolean));
      session.on("Network.webSocketFrameReceived", ({ response }) => {
        if (response.opcode === 1) this.#frame(response.payloadData);
      });
      session.once("close", () => this.#lost());
      await session.send("Network.enable");
    } catch (e) {
      this.#session = null;
      session.close();
      throw e;
    }
    this.emit("connect");
  }

  #frame(payload) {
    const e = parseFrame(payload);
    if (!e) return;
    this.emit("event", e);
    const me = this.#me;
    let x;
    if ((x = messageEvent(e, me))) this.emit("message", x);
    else if ((x = editEvent(e, me))) this.emit("edit", x);
    else if ((x = deleteEvent(e, me))) this.emit("delete", x);
    else if ((x = reactionEvent(e, me))) this.emit("reaction", x);
  }

  async #lost() {
    this.#session = null;
    if (this.#closed) return;
    this.emit("disconnect");
    if (!this.#opts.reconnect) return this.close({ restore: false });
    while (!this.#closed) {
      await sleep(this.#opts.reconnectDelay);
      if (this.#closed) return;
      try {
        await this.#attach();
        return;
      } catch {}
    }
  }

  async evaluate(expression) {
    if (!this.#session) throw new SlackError("not_connected");
    return this.#session.evaluate(expression);
  }

  // A workspace ID from an ID or a name prefix ("omc" for "OMC"); null stays null.
  async #team(team) {
    if (!team || TEAM_ID.test(team)) return team ?? null;
    const find = () => this.#workspaces?.find((w) => w.name.toLowerCase().startsWith(team.toLowerCase()));
    if (!find()) this.#workspaces = await this.evaluate(workspacesExpression);
    const w = find();
    if (!w) throw new SlackError("unknown_team");
    return w.id;
  }

  // Any Web API method. Returns the response body; throws SlackError when it isn't ok.
  // team is a workspace ID or name prefix; without it, the workspace active in the app.
  async api(method, params = {}, { team = null } = {}) {
    const teamId = await this.#team(team);
    for (let waited = 0, limited = 0; ; ) {
      const r = await this.evaluate(apiExpression(method, params, teamId));
      if (r?.ok) return r.body;
      // A freshly started page has no /api/ call to copy params from until it settles.
      if (r?.error === "no_template_call" && waited++ < TEMPLATE_WAIT_S) {
        await sleep(1000);
      } else if (r?.error === "ratelimited" && limited++ < RATE_LIMIT_RETRIES) {
        await sleep((r.retryAfter ?? 1) * 1000);
      } else {
        throw new SlackError(r?.error ?? "no_response", { retryAfter: r?.retryAfter ?? null, body: r?.body ?? null });
      }
    }
  }

  // Every item of a cursor-paginated method, page after page. key is the array to read
  // (channels, members, ...); without it, the first array in the response.
  async *paginate(method, params = {}, { team = null, key } = {}) {
    let cursor;
    do {
      const body = await this.api(method, { limit: 200, ...params, cursor }, { team });
      yield* (key ? body[key] : Object.values(body).find(Array.isArray)) ?? [];
      cursor = body.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  // The workspaces the app is signed in to: { id, name, url, userId, active, signedIn }.
  async workspaces() {
    this.#workspaces = await this.evaluate(workspacesExpression);
    return this.#workspaces;
  }

  // Your user ID in every workspace.
  async selfIds() {
    return (await this.workspaces()).map((w) => w.userId).filter(Boolean);
  }

  // Whether a user ID is you, in any workspace.
  isSelf(id) {
    return this.#me.has(id);
  }

  // A channel ID from an ID, "#name" or "name" (a conversation you're in), or "@name" or a
  // user ID (their DM, opened if needed).
  async resolveChannel(ref, { team = null } = {}) {
    if (CHANNEL_ID.test(ref)) return ref;
    if (USER_ID.test(ref)) return this.openDM(ref, { team });
    if (ref.startsWith("@")) {
      const u = await this.userByName(ref, { team });
      if (!u) throw new SlackError("user_not_found");
      return this.openDM(u.id, { team });
    }
    const c = await this.channelByName(ref, { team });
    if (!c) throw new SlackError("channel_not_found");
    return c.id;
  }

  async postMessage(channel, text, { threadTs, team = null, ...rest } = {}) {
    const id = await this.resolveChannel(channel, { team });
    return (await this.api("chat.postMessage", { channel: id, text, thread_ts: threadTs, ...rest }, { team })).ts;
  }

  // Replies in the message's thread (or starts one), in its workspace.
  reply(m, text, opts = {}) {
    return this.postMessage(m.channel, text, { threadTs: m.threadTs ?? m.ts, team: m.team, ...opts });
  }

  async updateMessage(channel, ts, text, { team = null, ...rest } = {}) {
    const id = await this.resolveChannel(channel, { team });
    await this.api("chat.update", { channel: id, ts, text, ...rest }, { team });
  }

  async deleteMessage(channel, ts, { team = null } = {}) {
    const id = await this.resolveChannel(channel, { team });
    await this.api("chat.delete", { channel: id, ts }, { team });
  }

  async react(channel, ts, name, { team = null } = {}) {
    const id = await this.resolveChannel(channel, { team });
    await this.api("reactions.add", { channel: id, timestamp: ts, name: name.replace(/:/g, "") }, { team });
  }

  // The DM (one user) or group DM (several) with these users, opened if needed.
  async openDM(users, { team = null } = {}) {
    const list = [users].flat().join(",");
    return (await this.api("conversations.open", { users: list }, { team })).channel.id;
  }

  // Uploads a file: data (string, Buffer or Uint8Array) or path. Returns { id, name, permalink }.
  async upload(channel, { data, path, filename, title, threadTs, comment, team = null } = {}) {
    const bytes = path ? await readFile(path) : Buffer.from(data ?? "");
    const name = filename ?? (path ? basename(path) : "file.txt");
    const id = await this.resolveChannel(channel, { team });
    const { upload_url, file_id } = await this.api("files.getUploadURLExternal", { filename: name, length: bytes.length }, { team });
    const r = await fetch(upload_url, { method: "POST", body: bytes });
    if (!r.ok) throw new SlackError(`upload_failed_${r.status}`);
    const body = await this.api(
      "files.completeUploadExternal",
      { files: [{ id: file_id, title: title ?? name }], channel_id: id, thread_ts: threadTs, initial_comment: comment },
      { team },
    );
    const f = body.files?.[0] ?? { id: file_id };
    return { id: f.id, name: f.name ?? name, permalink: f.permalink ?? null };
  }

  // Newest first, as the API returns them. With threadTs, that thread's replies instead.
  async history(channel, { limit = 20, oldest, latest, threadTs, team = null } = {}) {
    const id = await this.resolveChannel(channel, { team });
    const method = threadTs ? "conversations.replies" : "conversations.history";
    const body = await this.api(method, { channel: id, limit, oldest, latest, ts: threadTs }, { team });
    return body.messages.map((m) => message(m, this.#me));
  }

  // Messages matching a Slack search query ("from:@max in:#general deploy"), best first.
  async search(query, { count = 20, sort = "score", team = null } = {}) {
    const body = await this.api("search.messages", { query, count, sort }, { team });
    return (body.messages?.matches ?? []).map((m) => ({
      channel: m.channel?.id ?? null,
      channelName: m.channel?.name ?? null,
      ts: m.ts,
      user: m.user ?? null,
      username: m.username ?? null,
      text: m.text ?? "",
      permalink: m.permalink ?? null,
    }));
  }

  // Every conversation you're in: channels, private channels, group DMs and DMs.
  async conversations({ types = "public_channel,private_channel,mpim,im", team = null } = {}) {
    const all = [];
    for await (const c of this.paginate("users.conversations", { types, exclude_archived: true }, { team, key: "channels" })) all.push(conversation(c));
    return all;
  }

  async conversationInfo(channel, { team = null } = {}) {
    return conversation((await this.api("conversations.info", { channel }, { team })).channel);
  }

  // Lists are fetched once per workspace and kept for five minutes; refresh refetches.
  async #directory(kind, team, refresh, load) {
    const key = `${kind}:${await this.#team(team)}`;
    const cached = this.#directories.get(key);
    if (cached && !refresh && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.list;
    const list = load();
    this.#directories.set(key, { at: Date.now(), list });
    list.catch(() => this.#directories.delete(key));
    return list;
  }

  // A conversation you're in, by name ("general" or "#general"), or null.
  async channelByName(name, { team = null, refresh = false } = {}) {
    const want = name.replace(/^#/, "").toLowerCase();
    const list = await this.#directory("channels", team, refresh, () => this.conversations({ types: "public_channel,private_channel", team }));
    return list.find((c) => c.name?.toLowerCase() === want) ?? null;
  }

  // A user by display name, real name or username ("max" or "@max"), or null. Active
  // people win over deactivated accounts and bots.
  async userByName(name, { team = null, refresh = false } = {}) {
    const want = name.replace(/^@/, "").toLowerCase();
    const list = await this.#directory("users", team, refresh, async () => {
      const all = [];
      for await (const u of this.paginate("users.list", {}, { team, key: "members" })) all.push(person(u));
      return all;
    });
    const hits = list.filter((u) => [u.name, u.username, u.realName].some((n) => n?.toLowerCase() === want));
    return hits.sort((a, b) => a.deleted - b.deleted || a.bot - b.bot)[0] ?? null;
  }

  async userByEmail(email, { team = null } = {}) {
    try {
      return person((await this.api("users.lookupByEmail", { email }, { team })).user);
    } catch (e) {
      if (e.code === "users_not_found") return null;
      throw e;
    }
  }

  // Display name, falling back to real name and username; cached. The ID if it can't be read.
  async userName(id, { team = null } = {}) {
    if (!id) return "?";
    const key = `${team}:${id}`;
    if (!this.#names.has(key)) {
      const name = await this.api("users.info", { user: id }, { team })
        .then(({ user }) => person(user).name)
        .catch(() => id);
      this.#names.set(key, name);
    }
    return this.#names.get(key);
  }

  // "#general", "@Max" for a DM, "@a, b, c" for a group DM; cached. The ID if it can't be read.
  async place(channel, { team = null } = {}) {
    const key = `${team}:${channel}`;
    if (!this.#places.has(key)) {
      const info = await this.conversationInfo(channel, { team }).catch(() => null);
      let place = channel;
      if (info?.im) place = `@${await this.userName(info.user, { team })}`;
      else if (info?.mpim) place = `@${info.name.replace(/^mpdm-|-\d+$/g, "").split("--").join(", ")}`;
      else if (info) place = `#${info.name ?? channel}`;
      this.#places.set(key, place);
    }
    return this.#places.get(key);
  }

  async getStatus({ team = null } = {}) {
    const { profile: p } = await this.api("users.profile.get", {}, { team });
    return { text: p.status_text, emoji: p.status_emoji, expiresAt: p.status_expiration };
  }

  async setStatus({ text = "", emoji = "", expiresAt = 0 } = {}, { team = null } = {}) {
    await this.api("users.profile.set", { profile: { status_text: text, status_emoji: emoji, status_expiration: expiresAt } }, { team });
  }

  clearStatus({ team = null } = {}) {
    return this.setStatus({}, { team });
  }

  // Events of one kind ("message", "edit", "delete", "reaction", "event") as they arrive,
  // until close().
  async *stream(kind) {
    const stop = new AbortController();
    const onClose = () => stop.abort();
    this.once("close", onClose);
    try {
      for await (const [x] of on(this, kind, { signal: stop.signal })) yield x;
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally {
      this.off("close", onClose);
    }
  }

  messages() {
    return this.stream("message");
  }

  // Detaches. restore (default: whether connect() launched Slack) restarts Slack without
  // the DevTools port, closing it to other local processes.
  async close({ restore = this.launched } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    this.#session?.close();
    this.#session = null;
    if (restore) await restartSlack();
    this.emit("close");
  }
}

export const connect = (opts) => Slack.connect(opts);
