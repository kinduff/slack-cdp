// Answers your own "!ping" with "pong" in a thread: node examples/ping.js
import { connect } from "../index.js";

const slack = await connect();
process.on("SIGINT", () => slack.close().then(() => process.exit(0)));
slack.on("disconnect", () => console.log("lost Slack, reconnecting"));
slack.on("connect", () => console.log("connected"));
console.log("send !ping anywhere");

for await (const m of slack.messages()) {
  if (!m.self || m.text.trim() !== "!ping") continue;
  await slack.react(m.channel, m.ts, "eyes", { team: m.team });
  await slack.reply(m, "pong");
}
