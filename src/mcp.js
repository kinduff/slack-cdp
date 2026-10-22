// An MCP server (stdio, newline-delimited JSON-RPC) exposing Slack to AI agents: workspaces,
// conversations, history, search, sending, reactions, and an inbox of new messages.
// It connects on the first tool call; on exit it closes the client, which restarts Slack
// without the port if it launched it.
import { createInterface } from "node:readline";
import { connect } from "./client.js";
import { mentions, plainText } from "./events.js";
import pkg from "../package.json" with { type: "json" };

const INBOX_MAX = 500;
const WAIT_MAX_S = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const TEAM = { type: "string", description: "Workspace ID or name prefix; default: the one active in the app" };
const CHANNEL = { type: "string", description: "Channel ID, #name, @person for their DM, or a user ID" };

export function serveMcp({ connectOptions = {}, input = process.stdin, output = process.stdout, log = (...a) => console.error("slack-cdp mcp:", ...a) } = {}) {
  let ready = null;
  const inbox = [];
  let wake = () => {};

  function client() {
    ready ??= connect(connectOptions)
      .then((slack) => {
        slack.on("message", (m) => {
          inbox.push(m);
          if (inbox.length > INBOX_MAX) inbox.shift();
          wake();
        });
        slack.on("disconnect", () => log("lost the Slack page, reconnecting"));
        return slack;
      })
      .catch((e) => {
        ready = null;
        throw e;
      });
    return ready;
  }

  async function render(slack, m, team) {
    const names = new Map(await Promise.all(mentions(m.text).map(async (id) => [id, await slack.userName(id, { team })])));
    const who = m.self ? "me" : await slack.userName(m.user, { team });
    const thread = m.threadTs && m.threadTs !== m.ts ? ` (in thread ${m.threadTs})` : m.replies ? ` (${m.replies} replies)` : "";
    return `[${m.ts}] ${who}${thread}: ${plainText(m.text, (id) => names.get(id) ?? id)}`;
  }

  const tools = [
    {
      name: "slack_workspaces",
      description: "List the Slack workspaces the app is signed in to, with your user ID in each.",
      inputSchema: { type: "object", properties: {} },
      async run(slack) {
        const ws = await slack.workspaces();
        return ws.map((w) => `${w.id}  ${w.name}  you: ${w.userId}${w.active ? "  (active)" : ""}`).join("\n");
      },
    },
    {
      name: "slack_conversations",
      description: "List the conversations you're in (channels, private channels, group DMs, DMs) with their IDs.",
      inputSchema: {
        type: "object",
        properties: { team: TEAM, query: { type: "string", description: "Only names containing this" } },
      },
      async run(slack, { team, query }) {
        const lines = await Promise.all(
          (await slack.conversations({ team })).map(async (c) => `${c.id}  ${c.im ? `@${await slack.userName(c.user, { team })}` : `#${c.name}`}`),
        );
        const q = query?.toLowerCase();
        return lines.filter((l) => !q || l.toLowerCase().includes(q)).join("\n") || "no conversations";
      },
    },
    {
      name: "slack_history",
      description: "Read recent messages in a conversation, oldest first. Pass thread_ts to read a thread's replies.",
      inputSchema: {
        type: "object",
        properties: {
          channel: CHANNEL,
          team: TEAM,
          limit: { type: "integer", description: "Max messages (default 20)" },
          oldest: { type: "string", description: "Only messages after this ts" },
          thread_ts: { type: "string", description: "Read this thread's replies instead" },
        },
        required: ["channel"],
      },
      async run(slack, { channel, team, limit, oldest, thread_ts }) {
        const messages = (await slack.history(channel, { limit, oldest, threadTs: thread_ts, team })).reverse();
        return (await Promise.all(messages.map((m) => render(slack, m, team)))).join("\n") || "no messages";
      },
    },
    {
      name: "slack_search",
      description: 'Search messages with Slack search syntax, e.g. "deploy from:@max in:#general after:2026-01-01".',
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, team: TEAM, count: { type: "integer", description: "Max results (default 20)" } },
        required: ["query"],
      },
      async run(slack, { query, team, count }) {
        const hits = await slack.search(query, { team, count });
        return hits.map((h) => `#${h.channelName ?? h.channel} [${h.ts}] ${h.username ?? h.user}: ${h.text}`).join("\n") || "no matches";
      },
    },
    {
      name: "slack_send",
      description: "Post a message as you. Pass thread_ts to reply in a thread. It's posted from the user's own account.",
      inputSchema: {
        type: "object",
        properties: {
          channel: CHANNEL,
          text: { type: "string", description: "Message text (Slack mrkdwn)" },
          thread_ts: { type: "string", description: "Reply in this thread" },
          team: TEAM,
        },
        required: ["channel", "text"],
      },
      async run(slack, { channel, text, thread_ts, team }) {
        return `sent at ${await slack.postMessage(channel, text, { threadTs: thread_ts, team })}`;
      },
    },
    {
      name: "slack_react",
      description: "Add an emoji reaction to a message.",
      inputSchema: {
        type: "object",
        properties: { channel: CHANNEL, ts: { type: "string" }, name: { type: "string", description: "Emoji name, e.g. eyes" }, team: TEAM },
        required: ["channel", "ts", "name"],
      },
      async run(slack, { channel, ts, name, team }) {
        await slack.react(channel, ts, name, { team });
        return `reacted :${name.replace(/:/g, "")}:`;
      },
    },
    {
      name: "slack_inbox",
      description:
        "New messages received since the last call (or since the server connected), from every workspace and conversation. " +
        "Pass wait_s to wait for the first one if none are waiting.",
      inputSchema: {
        type: "object",
        properties: { wait_s: { type: "integer", description: `Seconds to wait when empty (default 0, max ${WAIT_MAX_S})` } },
      },
      async run(slack, { wait_s = 0 }) {
        if (!inbox.length && wait_s > 0) {
          await Promise.race([new Promise((r) => { wake = r; }), sleep(Math.min(wait_s, WAIT_MAX_S) * 1000)]);
          wake = () => {};
        }
        const teams = new Map((await slack.workspaces()).map((w) => [w.id, w.name]));
        const lines = await Promise.all(
          inbox.splice(0).map(async (m) => `${teams.get(m.team) ?? m.team} ${await slack.place(m.channel, { team: m.team })} (${m.channel}) ${await render(slack, m, m.team)}`),
        );
        return lines.join("\n") || "no new messages";
      },
    },
  ];

  async function handle({ method, params }) {
    switch (method) {
      case "initialize":
        return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slack-cdp", version: pkg.version } };
      case "ping":
        return {};
      case "tools/list":
        return { tools: tools.map(({ run, ...t }) => t) };
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) throw new RpcError(-32602, `unknown tool ${params?.name}`);
        try {
          return { content: [{ type: "text", text: await tool.run(await client(), params.arguments ?? {}) }] };
        } catch (e) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  const send = (msg) => output.write(JSON.stringify(msg) + "\n");

  async function answer(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (msg.id === undefined) return; // notifications need no answer
    try {
      send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  }

  const pending = new Set();
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  // Answers what's in flight, then closes the client. Resolves done.
  let stopping = false;
  async function stop() {
    if (stopping) return done;
    stopping = true;
    await Promise.allSettled(pending);
    const slack = await ready?.catch(() => null);
    await slack?.close().catch((e) => log(`close failed: ${e.message}`));
    resolveDone();
  }

  createInterface({ input })
    .on("line", (line) => {
      const p = answer(line).finally(() => pending.delete(p));
      pending.add(p);
    })
    .on("close", stop);

  return { done, stop };
}
