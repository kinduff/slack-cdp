// Expressions evaluated inside the Slack page. API calls use the page's own session: the
// token is read from localStorage and sent from the page, and never comes back over CDP.

const CONFIG = `JSON.parse(localStorage.getItem("localConfig_v2") || "{}")`;

// Form fields are strings; objects and arrays (blocks, profile, ...) go as JSON.
export const formFields = (params) =>
  Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
  );

// The API answers a credentialed request from the app's origin only when it carries the
// app's own _x_* query params, so they're copied from the page's latest /api/ call.
// team picks the workspace by ID; without it, the one active in the app.
export function apiExpression(method, params = {}, team = null) {
  return `(async () => {
    const c = ${CONFIG};
    const t = c.teams?.[${JSON.stringify(team)} ?? c.lastActiveTeamId];
    if (!t?.token) return { ok: false, error: ${JSON.stringify(team)} ? "unknown_team" : "no_session" };
    const template = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(t.url + "api/")).at(-1);
    if (!template) return { ok: false, error: "no_template_call" };
    const fd = new FormData();
    fd.append("token", t.token);
    for (const [k, v] of Object.entries(${JSON.stringify(formFields(params))})) fd.append(k, v);
    const r = await fetch(t.url + "api/" + ${JSON.stringify(method)} + new URL(template).search, { method: "POST", body: fd, credentials: "include" });
    const retryAfter = r.headers.get("retry-after");
    const body = await r.json();
    return { ok: body.ok, error: body.error, retryAfter: retryAfter ? Number(retryAfter) : null, body };
  })()`;
}

export const workspacesExpression = `(() => {
  const c = ${CONFIG};
  return Object.entries(c.teams ?? {}).map(([id, t]) => ({ id, name: t.name, url: t.url, userId: t.user_id, active: id === c.lastActiveTeamId, signedIn: Boolean(t.token) }));
})()`;

// Workspace IDs that have an /api/ call to copy params from yet.
export const templatesExpression = `(() => {
  const c = ${CONFIG};
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  return Object.entries(c.teams ?? {}).filter(([, t]) => urls.some((u) => u.startsWith(t.url + "api/"))).map(([id]) => id);
})()`;
