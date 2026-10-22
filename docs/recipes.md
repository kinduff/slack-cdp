# Recipes

Patterns for building on slack-cdp, and the pitfalls each one avoids. Every snippet
assumes:

```js
import { connect, mentions, plainText, SlackError } from "slack-cdp";
const slack = await connect();
```

## A command bot that doesn't answer itself

Your own messages arrive as events too, including the bot's replies. Skip `self`
messages, or mark replies and skip those, or the bot can loop.

```js
for await (const m of slack.messages()) {
  if (m.bot || m.self) continue;
  const ask = m.text.match(/^!weather\s+(.+)/)?.[1];
  if (ask) await slack.reply(m, `looking up ${ask}…`);
}
```

To let yourself trigger it too, keep `self` messages but skip the ones the bot wrote:

```js
const MARK = ":robot_face: ";
if (m.self && m.text.startsWith(MARK)) continue;
await slack.reply(m, MARK + answer);
```

## Answer in the right workspace

Events come from every signed-in workspace, but calls without `team` go to whichever one
is active in the app. Always carry the message's team:

```js
await slack.reply(m, "ok");                                  // uses m.team
await slack.postMessage(m.channel, "ok", { team: m.team });  // same, by hand
```

## Readable text

```js
const names = new Map(await Promise.all(mentions(m.text).map(async (id) => [id, await slack.userName(id, { team: m.team })])));
const text = plainText(m.text, (id) => names.get(id) ?? id);
const where = await slack.place(m.channel, { team: m.team }); // "#general", "@Max"
```

## Thread context

```js
if (m.threadTs) {
  const replies = await slack.history(m.channel, { threadTs: m.threadTs, team: m.team, limit: 100 });
  const before = replies.filter((r) => r.ts !== m.ts).reverse(); // oldest first
}
```

## Mentions and DMs only

```js
for await (const m of slack.messages()) {
  const mentioned = mentions(m.text).some((id) => slack.isSelf(id));
  const info = await slack.conversationInfo(m.channel, { team: m.team }).catch(() => null);
  if (mentioned || info?.im || info?.mpim) notify(m);
}
```

## Edits, deletes and reactions

```js
slack.on("edit", (e) => console.log(`${e.user} changed "${e.previousText}" to "${e.text}"`));
slack.on("delete", (d) => console.log(`${d.user} deleted "${d.text ?? "?"}"`));
slack.on("reaction", (r) => {
  if (r.added && r.itemUser && slack.isSelf(r.itemUser)) console.log(`${r.user} reacted :${r.name}: to you`);
});
```

Anything else Slack sends (typing, presence, channel joins) is on `event`:

```js
slack.on("event", (e) => e.type === "user_typing" && console.log(`${e.user} is typing in ${e.channel}`));
```

## One request at a time

Slack rate-limits per method. `api()` waits out `ratelimited` up to three times, but a
burst of replies still piles up. Queue work that posts:

```js
let queue = Promise.resolve();
for await (const m of slack.messages()) {
  queue = queue.then(() => handle(m)).catch((e) => console.error(e));
}
```

## Errors

```js
try {
  await slack.postMessage("#announcements", "hi");
} catch (e) {
  if (e instanceof SlackError && e.code === "not_in_channel") console.error("join it first");
  else if (e instanceof SlackError && e.code === "restricted_action") console.error("posting there is restricted");
  else throw e;
}
```

Library codes: `not_connected` (after `close()` or while reconnecting), `unknown_team`,
`channel_not_found` / `user_not_found` (a `#name` or `@name` that didn't resolve),
`no_session` (signed out), `no_template_call` (Slack never made an API call to copy
params from; it waited 30 s).

## Surviving restarts

With `reconnect` (the default), the client reattaches when Slack comes back; calls made
in between throw `not_connected`. Watch the state:

```js
slack.on("disconnect", () => console.log("Slack went away"));
slack.on("connect", () => console.log("back"));
```

## Any API method

`api()` reaches the whole [Web API](https://api.slack.com/methods) with your user's
permissions. Objects and arrays are sent as JSON:

```js
await slack.api("chat.scheduleMessage", { channel: "C123", text: "standup", post_at: Math.floor(Date.now() / 1000) + 3600 });
await slack.api("chat.postMessage", { channel: "C123", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }] });
for await (const f of slack.paginate("files.list", { user: "U123" }, { key: "files" })) console.log(f.name);
```

Some methods need scopes your user session doesn't have, or are admin-only; they fail with
Slack's own error code.

## Clean exit

If `connect({ launch: true })` opened the port, `close()` restarts Slack without it. Wire
it to signals so Ctrl+C doesn't leave the port open:

```js
const slack = await connect({ launch: true });
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => slack.close().finally(() => process.exit(0)));
```

## When it stops working

Run `npx slack-cdp doctor`. It walks app → port → page → session → API params → auth
and names the first broken link, with a hint.
