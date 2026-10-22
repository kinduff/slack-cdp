// A Chrome DevTools Protocol session with one page target: commands, and the events the
// target sends back.
import { EventEmitter } from "node:events";

export async function findPage({ host, port, match }) {
  const targets = await (await fetch(`http://${host}:${port}/json/list`)).json();
  return targets.find((t) => t.type === "page" && match(t.url)) ?? null;
}

export class Session extends EventEmitter {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(url) {
    const session = new Session();
    await session.#open(url);
    return session;
  }

  async #open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP connection failed"));
    });
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.id) {
        const p = this.#pending.get(j.id);
        if (!p) return;
        this.#pending.delete(j.id);
        if (j.error) p.reject(new Error(`CDP: ${j.error.message}`));
        else p.resolve(j.result);
      } else if (j.method) {
        this.emit(j.method, j.params);
      }
    };
    ws.onclose = () => {
      for (const p of this.#pending.values()) p.reject(new Error("CDP connection closed"));
      this.#pending.clear();
      this.emit("close");
    };
    this.#ws = ws;
  }

  send(method, params = {}) {
    if (this.#ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page evaluation threw");
    return r.result?.value;
  }

  close() {
    this.#ws?.close();
  }
}
