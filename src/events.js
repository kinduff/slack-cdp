// Picks messages, edits, deletes and reactions out of the frames the Slack page receives on
// its websocket, and turns Slack's message markup into plain text. me is a set of your user
// IDs, for the self flag.
const KEEP = new Set([undefined, "thread_broadcast", "file_share", "me_message"]);
const NOBODY = new Set();

export function parseFrame(payload) {
  try {
    const e = JSON.parse(payload);
    return e && typeof e === "object" && typeof e.type === "string" ? e : null;
  } catch {
    return null;
  }
}

const event = (e) => (typeof e === "string" ? parseFrame(e) : e);
const files = (m) => (m.files ?? []).map((f) => f.name ?? f.title ?? "file");

// A new message, or null for anything else.
export function messageEvent(e, me = NOBODY) {
  e = event(e);
  if (e?.type !== "message" || !KEEP.has(e.subtype) || !e.channel || !e.ts) return null;
  const user = e.user ?? e.bot_id ?? null;
  return {
    team: e.team ?? null,
    channel: e.channel,
    user,
    bot: !e.user && Boolean(e.bot_id),
    self: me.has(user),
    text: e.text ?? "",
    ts: e.ts,
    threadTs: e.thread_ts ?? null,
    files: files(e),
  };
}

// A message whose text changed, or null. Slack also sends message_changed for unfurls and
// reply counts; those keep their text and are skipped.
export function editEvent(e, me = NOBODY) {
  e = event(e);
  if (e?.type !== "message" || e.subtype !== "message_changed" || !e.message) return null;
  const before = e.previous_message?.text;
  if (before !== undefined && before === e.message.text) return null;
  const user = e.message.user ?? e.message.bot_id ?? null;
  return {
    team: e.team ?? e.message.team ?? null,
    channel: e.channel,
    user,
    self: me.has(user),
    text: e.message.text ?? "",
    previousText: before ?? null,
    ts: e.message.ts,
    threadTs: e.message.thread_ts ?? null,
  };
}

// A deleted message, or null. text is what it said, when Slack sends it.
export function deleteEvent(e, me = NOBODY) {
  e = event(e);
  if (e?.type !== "message" || e.subtype !== "message_deleted" || !e.deleted_ts) return null;
  const user = e.previous_message?.user ?? e.previous_message?.bot_id ?? null;
  return {
    team: e.team ?? null,
    channel: e.channel,
    user,
    self: me.has(user),
    text: e.previous_message?.text ?? null,
    ts: e.deleted_ts,
    threadTs: e.previous_message?.thread_ts ?? null,
  };
}

// A reaction added to or removed from a message, or null.
export function reactionEvent(e, me = NOBODY) {
  e = event(e);
  if ((e?.type !== "reaction_added" && e?.type !== "reaction_removed") || e.item?.type !== "message") return null;
  return {
    team: e.team ?? null,
    channel: e.item.channel,
    ts: e.item.ts,
    user: e.user,
    self: me.has(e.user),
    name: e.reaction,
    added: e.type === "reaction_added",
    itemUser: e.item_user ?? null,
  };
}

export const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// User IDs mentioned as <@U123>, to look up before plainText.
export const mentions = (text) => [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];

// <@U123> -> @name, <#C123|general> -> #general, <!here> -> @here, <url|text> -> text (url).
export function plainText(text, name = (id) => id) {
  return unescape(
    text.replace(/<([^>]+)>/g, (_, inner) => {
      const [target, label] = inner.split("|");
      if (target.startsWith("@")) return `@${name(target.slice(1))}`;
      if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
      if (target.startsWith("!subteam^")) return label ?? "@group";
      if (target.startsWith("!")) return `@${target.slice(1).split("^")[0]}`;
      const url = target.replace(/^mailto:/, "");
      return label && label !== url ? `${label} (${url})` : url;
    }),
  );
}
