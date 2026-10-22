# slack-cdp

Script Slack as yourself, through the desktop app's own session. No Slack app, no bot
token, no OAuth: slack-cdp attaches to the Slack desktop app over the Chrome DevTools
Protocol, makes Web API calls inside the app's page with the page's session, and listens
to the events the page receives on its own websocket.

Comes as a library (with TypeScript types), a CLI, and an MCP server for AI agents.
Node 22+, no dependencies.

> [!WARNING]
> **While Slack's DevTools port is open, any process on your machine can take over your
> Slack session.** The port binds to 127.0.0.1, which only keeps out other machines. Open
> it only while you need it. With `launch: true` / `--launch`, slack-cdp restarts Slack
> without the port when it's done.

Unofficial: it relies on Slack internals that can change without notice (run
`slack-cdp doctor` when something breaks), and everything it does, it does as you. Check
your workspace's rules before automating your account.

## Install

```sh
npm install github:kinduff/slack-cdp
```

## Start Slack with the port

`connect({ launch: true })` and `--launch` quit Slack and start it again with the port.
Or start it yourself:

| Install | Command |
| --- | --- |
| Linux flatpak | `flatpak run com.slack.Slack --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` |
| Linux deb/rpm/snap | `slack --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` |
| macOS | `open -a Slack --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` |
| Windows | `%LOCALAPPDATA%\slack\slack.exe --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` |

Quit Slack fully first: if it's already running, the new launch just focuses it. Only the
flatpak launcher has been tested; the Microsoft Store build of Slack isn't supported.

Then check the chain:

```sh
npx slack-cdp doctor
```

```
ok   app: found Slack flatpak
ok   port: 127.0.0.1:9222 answers (Chrome/138.0.7204.251)
ok   page: https://app.slack.com/client/T029JKK3Y/D08CLGLHL0J
ok   session: 2 workspaces: Acme, Side Project
ok   api params: every workspace has API params to copy
ok   auth Acme: signed in as kinduff (U08CHMKQ9NZ)
```

## Library

```js
import { connect } from "slack-cdp";

const slack = await connect({ launch: true });

for await (const m of slack.messages()) {
  if (m.self || m.bot) continue;
  if (m.text.startsWith("!ping")) await slack.reply(m, "pong");
}
```

```js
await slack.postMessage("#general", "deploy done :rocket:", { team: "acme" });
await slack.postMessage("@max", "lunch?");
await slack.upload("#releases", { path: "./changelog.md", comment: "v2 notes" });
const hits = await slack.search("from:@max in:#general deploy");
const thread = await slack.history("#general", { threadTs: "1792699294.295379" });
const body = await slack.api("emoji.list"); // any Web API method
```

More in [`docs/recipes.md`](docs/recipes.md) and [`examples/`](examples).

### Workspaces

Every call takes `{ team }`: a workspace ID or a name prefix (`"acme"`). Without it, calls
go to the workspace active in the app, which changes when you click another workspace.
Events arrive from every workspace, each with its `team`, so answer with `slack.reply(m, …)`
or pass `{ team: m.team }`.

### Channels

Methods that take a channel accept an ID (`C…`, `G…`, `D…`), `#name` or `name` for a
conversation you're in, or `@person` or a user ID for their DM, opened if needed.

### API

| Call | Returns |
| --- | --- |
| `connect({ host, port, launch, reconnect, reconnectDelay })` | A `Slack`. Defaults: `127.0.0.1`, `9222`, no launch, reconnect every 5 s |
| `api(method, params, { team })` | Any [Web API method](https://api.slack.com/methods)'s response body. Objects in `params` go as JSON. Throws `SlackError` (`code`, `retryAfter`, `body`); waits out rate limits up to 3 times |
| `paginate(method, params, { team, key })` | Async iterator over every item of a cursor-paginated method |
| `postMessage(channel, text, { threadTs, team, ...params })` | The `ts`. Extra params (`blocks`, `unfurl_links`, …) pass through |
| `reply(message, text, params)` | The `ts`. In the message's thread and workspace |
| `updateMessage(channel, ts, text, params)` / `deleteMessage(channel, ts)` | Edits or deletes your message |
| `react(channel, ts, name)` | Adds a reaction |
| `upload(channel, { data \| path, filename, title, comment, threadTs })` | `{ id, name, permalink }` |
| `openDM(user \| users)` | DM or group DM channel ID |
| `history(channel, { limit, oldest, latest, threadTs })` | Messages, newest first; a thread's replies with `threadTs` |
| `search(query, { count, sort })` | `{ channel, channelName, ts, user, username, text, permalink }[]` |
| `conversations({ types })` | Every conversation you're in |
| `conversationInfo(channel)` | `{ id, name, user, im, mpim, private }` |
| `channelByName(name)` / `userByName(name)` / `userByEmail(email)` | Lookup or `null`; name lists cached 5 min |
| `userName(id)` / `place(channel)` | Display name / `#general`, `@Max`; cached |
| `resolveChannel(ref)` | A channel ID from any channel reference |
| `workspaces()` / `selfIds()` / `isSelf(id)` | Signed-in workspaces / your user IDs / whether an ID is you |
| `getStatus()` / `setStatus({ text, emoji, expiresAt })` / `clearStatus()` | Your status |
| `messages()` / `stream(kind)` | Async iterators of new events until `close()` |
| `evaluate(expression)` | Runs JS in the Slack page |
| `close({ restore })` | Detaches; `restore` (default: whether `connect()` launched Slack) restarts Slack without the port |

Events (`slack.on(…)`):

| Event | Payload |
| --- | --- |
| `message` | `{ team, channel, user, bot, self, text, ts, threadTs, files }` |
| `edit` | `{ team, channel, user, self, text, previousText, ts, threadTs }` |
| `delete` | `{ team, channel, user, self, text, ts, threadTs }` |
| `reaction` | `{ team, channel, ts, user, self, name, added, itemUser }` |
| `event` | Every raw websocket event: typing, presence, channel joins, … |
| `connect` / `disconnect` / `close` | Connection state; reconnects follow a `disconnect` |

You get events for the conversations you're in, as the app does. `text` is Slack markup;
`plainText(text, idToName)` renders mentions, channel links and URLs readably, and
`mentions(text)` lists the user IDs to look up first.

Also exported: `doctor()`, `detectApp()`, `restartSlack()`, `serveMcp()`, and the pure
event parsers. Types are in `index.d.ts`.

## CLI

```sh
slack-cdp doctor
slack-cdp tail --org acme --channel general --mentions
slack-cdp send '#general' 'hello'
echo 'from stdin' | slack-cdp send @max
slack-cdp history '#general' -n 50
slack-cdp search 'from:@max deploy'
slack-cdp api emoji.list --org acme
slack-cdp tail --json | jq .text
```

`slack-cdp --help` lists everything. Add `--launch` to open the port if it isn't open.

## MCP server

`slack-cdp mcp` serves Slack to AI agents over stdio, with tools for workspaces,
conversations, history, search, send, react, and an inbox of new messages. For Claude
Code, in `.mcp.json`:

```json
{ "mcpServers": { "slack": { "command": "npx", "args": ["slack-cdp", "mcp", "--launch"] } } }
```

The agent posts as you. Give it to agents you'd hand your Slack account to.

## How it works

- CDP `Runtime.evaluate` on the `app.slack.com` page target. The page's
  `localStorage.localConfig_v2` holds each signed-in workspace's token and URL.
- The API accepts the page's credentialed requests only with the app's own `_x_*` query
  params, so they're copied from the page's most recent `/api/` call. Right after Slack
  starts there is none yet; calls wait up to 30 s for one (`no_template_call`).
- The token never crosses CDP: it's read and sent inside the page. Responses do come back.
- CDP `Network.enable` plus `Network.webSocketFrameReceived` taps the page's websocket,
  whose frames are Slack's RTM-style JSON events.

## Development

```sh
npm test
```

Tests run against a fake DevTools port (`test/fake-slack.js`) that evaluates the real page
expressions in a sandbox, so they need no Slack. See [`AGENTS.md`](AGENTS.md) before changing
things.

## License

MIT
