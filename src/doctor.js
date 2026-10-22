// Checks each link in the chain, app to API, and says which one broke and what to try.
// Slack's internals change without notice; this is the first thing to run when calls fail.
import { Session, findPage } from "./cdp.js";
import { apiExpression, templatesExpression, workspacesExpression } from "./page.js";
import { detectApp } from "./app.js";
import { isSlackPage } from "./client.js";

export async function doctor({ host = "127.0.0.1", port = 9222 } = {}) {
  const checks = [];
  const check = (name, status, detail, hint) => checks.push({ name, status, detail, ...(hint && { hint }) });
  const result = () => ({ ok: !checks.some((c) => c.status === "fail"), checks });

  const app = await detectApp().catch(() => null);
  if (app) check("app", "ok", `found ${app.name}`);
  else check("app", "warn", "no Slack desktop app found to launch", "fine if you start Slack yourself with --remote-debugging-port");

  let browser;
  try {
    browser = await (await fetch(`http://${host}:${port}/json/version`)).json();
    check("port", "ok", `${host}:${port} answers (${browser.Browser ?? "unknown browser"})`);
  } catch {
    check("port", "fail", `nothing answers on ${host}:${port}`, `start Slack with --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1, or connect({ launch: true })`);
    return result();
  }

  const page = await findPage({ host, port, match: isSlackPage }).catch(() => null);
  if (!page) {
    check("page", "fail", "no https://app.slack.com/ page target", "the port may belong to another app, or Slack is still loading; wait and retry");
    return result();
  }
  check("page", "ok", page.url.split("?")[0]);

  let session;
  try {
    session = await Session.open(page.webSocketDebuggerUrl);
    const workspaces = await session.evaluate(workspacesExpression);
    const signedIn = workspaces.filter((w) => w.signedIn);
    if (!signedIn.length) {
      check("session", "fail", "localConfig_v2 has no signed-in workspaces", "sign in to Slack; if you are, Slack changed how it stores sessions");
      return result();
    }
    check("session", "ok", `${signedIn.length} workspace${signedIn.length === 1 ? "" : "s"}: ${signedIn.map((w) => w.name).join(", ")}`);

    const ready = new Set(await session.evaluate(templatesExpression));
    const waiting = signedIn.filter((w) => !ready.has(w.id));
    if (waiting.length) check("api params", "warn", `no API call to copy params from yet for ${waiting.map((w) => w.name).join(", ")}`, "calls wait up to 30 s for one; opening that workspace in the app makes one");
    else check("api params", "ok", "every workspace has API params to copy");

    for (const w of signedIn.filter((w) => ready.has(w.id))) {
      const r = await session.evaluate(apiExpression("auth.test", {}, w.id));
      if (r?.ok) check(`auth ${w.name}`, "ok", `signed in as ${r.body.user} (${r.body.user_id})`);
      else check(`auth ${w.name}`, "fail", `auth.test: ${r?.error ?? "no response"}`, "sign in again in the app; if that doesn't help, Slack changed its API params");
    }
  } catch (e) {
    check("session", "fail", e.message, "Slack may be reloading; retry");
  } finally {
    session?.close();
  }
  return result();
}
