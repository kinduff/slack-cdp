// A stand-in for Slack's DevTools port: /json/list with one app.slack.com page, a minimal
// websocket server for CDP, and Runtime.evaluate run in a vm with a fake localStorage,
// performance entries and fetch, so the real page expressions run unchanged.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import vm from "node:vm";

const TEAMS = {
  T0000001: { name: "Acme", url: "https://acme.slack.com/", user_id: "U0000ME1", token: "xoxc-secret-1" },
  T0000002: { name: "Side Project", url: "https://side.slack.com/", user_id: "U0000ME2", token: "xoxc-secret-2" },
};

function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

// Yields complete client frames as { opcode, text } from a growing buffer.
function* frames(state) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    let len = b[1] & 127;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      len = Number(b.readBigUInt64BE(2));
      at = 10;
    }
    const masked = b[1] & 128;
    const end = at + (masked ? 4 : 0) + len;
    if (b.length < end) return;
    const data = b.subarray(at + (masked ? 4 : 0), end);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= b[at + (i % 4)];
    state.buf = b.subarray(end);
    yield { opcode: b[0] & 15, text: data.toString() };
  }
}

// handlers: { "chat.postMessage": (fields, team) => body }. Unknown methods answer unknown_method.
export async function fakeSlack({ handlers = {}, templates = true } = {}) {
  const calls = [];
  const uploads = [];
  const sockets = new Set();
  const config = JSON.stringify({ teams: TEAMS, lastActiveTeamId: "T0000001" });
  let resources = templates ? Object.values(TEAMS).map((t) => ({ name: `${t.url}api/client.counts?_x_id=abc` })) : [];

  async function fakeFetch(url, init) {
    const u = new URL(url);
    const team = Object.keys(TEAMS).find((id) => url.startsWith(TEAMS[id].url));
    const method = u.pathname.replace("/api/", "");
    const fields = Object.fromEntries(init.body.entries());
    calls.push({ method, team, fields, query: u.search });
    const handler = handlers[method];
    const body = handler ? await handler(fields, team) : { ok: false, error: "unknown_method" };
    const headers = body?.retryAfter ? { "retry-after": String(body.retryAfter) } : {};
    return new Response(JSON.stringify(body), { headers });
  }

  const context = vm.createContext({
    localStorage: { getItem: (k) => (k === "localConfig_v2" ? config : null) },
    performance: { getEntriesByType: () => resources },
    fetch: fakeFetch,
    FormData,
    URL,
    Response,
  });

  async function evaluate(expression) {
    try {
      const value = await vm.runInContext(expression, context);
      return { result: { type: typeof value, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
    } catch (e) {
      return { result: { type: "object" }, exceptionDetails: { exception: { description: String(e) } } };
    }
  }

  const server = createServer((req, res) => {
    const { port } = server.address();
    const page = { type: "page", url: "https://app.slack.com/client/T0000001", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` };
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url.startsWith("/upload/")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        uploads.push({ url: req.url, body: Buffer.concat(chunks).toString() });
        res.end("OK");
      });
    } else if (req.url === "/json/list") res.end(JSON.stringify([page]));
    else if (req.url === "/json/version") res.end(JSON.stringify({ Browser: "FakeSlack/1.0" }));
    else res.writeHead(404).end("{}");
  });

  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    const state = { buf: Buffer.alloc(0) };
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      for (const { opcode, text } of frames(state)) {
        if (opcode === 8) return socket.end(Buffer.from([0x88, 0]));
        if (opcode !== 1) continue;
        const { id, method, params } = JSON.parse(text);
        const result = method === "Runtime.evaluate" ? await evaluate(params.expression) : {};
        if (!socket.destroyed) socket.write(frame(JSON.stringify({ id, result })));
      }
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  return {
    port: server.address().port,
    calls,
    uploads,
    teams: TEAMS,
    // Sends a Slack websocket event to every attached client, as the page would receive it.
    push(event) {
      const msg = JSON.stringify({ method: "Network.webSocketFrameReceived", params: { response: { opcode: 1, payloadData: JSON.stringify(event) } } });
      for (const s of sockets) s.write(frame(msg));
    },
    get attached() {
      return sockets.size;
    },
    setTemplates(on) {
      resources = on ? Object.values(TEAMS).map((t) => ({ name: `${t.url}api/client.counts?_x_id=abc` })) : [];
    },
    // Drops every CDP connection, as when Slack quits or reloads.
    drop() {
      for (const s of sockets) s.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}
