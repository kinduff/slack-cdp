import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteEvent, editEvent, mentions, messageEvent, parseFrame, plainText, reactionEvent } from "../src/events.js";

const frame = (over = {}) => JSON.stringify({ type: "message", channel: "D01", user: "U01", text: "hi", ts: "1800000000.000100", ...over });

test("picks a plain message", () => {
  assert.deepEqual(messageEvent(frame({ team: "T01" })), { team: "T01", channel: "D01", user: "U01", bot: false, self: false, text: "hi", ts: "1800000000.000100", threadTs: null, files: [] });
});

test("flags your own messages", () => {
  assert.equal(messageEvent(frame(), new Set(["U01"])).self, true);
});

test("takes a parsed event too", () => {
  assert.equal(messageEvent(JSON.parse(frame())).text, "hi");
});

test("keeps thread replies and broadcasts", () => {
  assert.equal(messageEvent(frame({ thread_ts: "1800000000.000001" })).threadTs, "1800000000.000001");
  assert.ok(messageEvent(frame({ subtype: "thread_broadcast" })));
});

test("uses the bot ID when there's no user, and flags it", () => {
  const m = messageEvent(frame({ user: undefined, bot_id: "B01" }));
  assert.equal(m.user, "B01");
  assert.equal(m.bot, true);
});

test("skips edits, deletes, other events and junk", () => {
  assert.equal(messageEvent(frame({ subtype: "message_changed" })), null);
  assert.equal(messageEvent(frame({ subtype: "message_deleted" })), null);
  assert.equal(messageEvent(JSON.stringify({ type: "user_typing", channel: "D01" })), null);
  assert.equal(messageEvent(JSON.stringify({ type: "pong" })), null);
  assert.equal(messageEvent("not json"), null);
});

test("parseFrame keeps only typed events", () => {
  assert.deepEqual(parseFrame('{"type":"hello"}'), { type: "hello" });
  assert.equal(parseFrame("[1,2]"), null);
  assert.equal(parseFrame("null"), null);
  assert.equal(parseFrame("nope"), null);
});

test("lists file names", () => {
  assert.deepEqual(messageEvent(frame({ subtype: "file_share", files: [{ name: "a.png" }, { title: "notes" }] })).files, ["a.png", "notes"]);
});

test("plainText renders mentions, channels, specials and links", () => {
  const names = { U01: "Max" };
  const text = "hey <@U01>, see <#C01|general> <!here> <!subteam^S01|@devs> <https://x.com|this> <https://y.com> <mailto:a@b.co|a@b.co> 1 &lt; 2 &amp; 3";
  assert.equal(plainText(text, (id) => names[id] ?? id), "hey @Max, see #general @here @devs this (https://x.com) https://y.com a@b.co 1 < 2 & 3");
});

test("mentions finds each mentioned user once", () => {
  assert.deepEqual(mentions("<@U01> and <@U02|bob> and <@U01>"), ["U01", "U02"]);
});

test("editEvent keeps text changes and skips unfurl and reply-count updates", () => {
  const changed = (prev, next) => ({ type: "message", subtype: "message_changed", channel: "C01", message: { user: "U01", text: next, ts: "1", thread_ts: "0" }, previous_message: { text: prev } });
  assert.deepEqual(editEvent(changed("a", "b"), new Set(["U01"])), { team: null, channel: "C01", user: "U01", self: true, text: "b", previousText: "a", ts: "1", threadTs: "0" });
  assert.equal(editEvent(changed("same", "same")), null);
  assert.equal(editEvent(frame()), null);
});

test("deleteEvent reports the deleted ts and what it said", () => {
  const e = { type: "message", subtype: "message_deleted", channel: "C01", deleted_ts: "5", previous_message: { user: "U02", text: "oops" } };
  assert.deepEqual(deleteEvent(e), { team: null, channel: "C01", user: "U02", self: false, text: "oops", ts: "5", threadTs: null });
  assert.equal(deleteEvent(frame()), null);
});

test("reactionEvent covers added and removed reactions on messages", () => {
  const r = (type, item = { type: "message", channel: "C01", ts: "1" }) => ({ type, user: "U02", reaction: "eyes", item, item_user: "U01" });
  assert.deepEqual(reactionEvent(r("reaction_added")), { team: null, channel: "C01", ts: "1", user: "U02", self: false, name: "eyes", added: true, itemUser: "U01" });
  assert.equal(reactionEvent(r("reaction_removed")).added, false);
  assert.equal(reactionEvent(r("reaction_added", { type: "file", file: "F1" })), null);
});
