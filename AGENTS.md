# AGENTS.md

Notes for coding agents (and people) changing slack-cdp. For using the library, see
README.md and docs/recipes.md.

## What this is

A Node library, CLI and MCP server that drives the Slack desktop app over the Chrome
DevTools Protocol. Web API calls run inside the `app.slack.com` page with its session;
events come from tapping the page's websocket. Everything acts as the signed-in user.

## Layout

| Path | Role |
| --- | --- |
| `src/cdp.js` | CDP session: commands with ids, events, `Runtime.evaluate` |
| `src/page.js` | JS expressions evaluated in the page: API call, workspaces, template check |
| `src/client.js` | `Slack` class: API, helpers, caches, event dispatch, reconnect |
| `src/events.js` | Pure parsers for websocket events and Slack markup |
| `src/app.js` | Find, stop and start the Slack desktop app per platform |
| `src/doctor.js` | Step-by-step health check |
| `src/mcp.js` | MCP server over stdio |
| `bin/slack-cdp` | CLI |
| `index.js` / `index.d.ts` | Public exports and their types |
| `test/fake-slack.js` | Fake DevTools port that runs page expressions in a `vm` |

## Rules

- **No runtime dependencies.** Node 22 built-ins only (global `WebSocket`, `fetch`,
  `FormData`). Don't add a `dependencies` entry. Dev tooling stays out of the repo too.
- **The token never leaves the page.** Page expressions read the token from
  `localStorage` and send it from inside the page. Never return it, log it, or add a code
  path that evaluates `localStorage` and sends the result back. Tests assert responses
  don't contain it; keep that true.
- **Everything is the user.** Any feature that posts, reacts, edits or deletes acts as a
  real person. Don't add anything that does so implicitly (no auto-replies, no "test
  message on connect").
- **Keep `index.d.ts` in step** with every public change: new method, option, field or
  event. It's handwritten.
- **Page expressions are strings.** Interpolate values only through `JSON.stringify`, never
  string concatenation, so quotes and backticks in user input can't break out. There's a
  test for this in `test/page.test.js`.
- Public behavior changes go in `CHANGELOG.md` under Unreleased.

## Fragile Slack internals

These are what break when Slack changes. Isolate any new dependence on internals in
`src/page.js` and add a `doctor` check for it.

- `localStorage.localConfig_v2`: `teams[id] = { name, url, token, user_id }`, `lastActiveTeamId`.
- The `_x_*` query params copied from the latest `performance` resource entry under
  `<team url>api/`. Without them the API rejects credentialed calls from the page.
- Websocket frames are plain JSON with RTM event shapes (`type`, `subtype`, `channel`,
  `ts`, ...). Slack also sends `message_changed` for unfurls and reply counts; `editEvent`
  skips those by comparing text.
- The page target is the one whose URL starts with `https://app.slack.com/`.

## Testing

- `npm test` runs everything against `test/fake-slack.js`: no Slack needed, ~4 s. Add a
  handler there for any new API method you call, and a test in `test/client.test.js`.
- Pure parsing goes in `test/events.test.js`.
- Live checks against the real app are fine for reading (`slack-cdp doctor`,
  `workspaces`, `history`). For anything that posts, use only your own self-DM (the DM
  with yourself, `@your-name`). Never post to channels or other people's DMs while
  testing, and delete test messages afterwards.
- Don't restart someone's Slack (`launch`, `restartSlack`) without asking: it drops their
  calls and huddles.
- The Linux flatpak launcher is the only launcher that has been tested. The macOS, Windows
  and native Linux paths in `src/app.js` follow each app's documented flags but have not
  run; say so if you change them without testing.

## Style

Plain ES modules, two-space indent, double quotes, semicolons, lines up to ~140 columns.
Comments explain why, not what. Errors from Slack are `SlackError` with Slack's own
`code`; library errors that callers can act on use snake_case codes the same way
(`not_connected`, `unknown_team`, `channel_not_found`).
