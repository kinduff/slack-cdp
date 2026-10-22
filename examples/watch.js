// Logs edits, deletes and reactions as they happen: node examples/watch.js
import { connect } from "../index.js";

const slack = await connect();
process.on("SIGINT", () => slack.close().then(() => process.exit(0)));
const who = (e) => slack.userName(e.user, { team: e.team });

slack.on("edit", async (e) => console.log(`${await who(e)} edited: "${e.previousText}" -> "${e.text}"`));
slack.on("delete", async (e) => console.log(`${await who(e)} deleted: "${e.text ?? "?"}"`));
slack.on("reaction", async (e) => console.log(`${await who(e)} ${e.added ? "added" : "removed"} :${e.name}: on ${e.channel}/${e.ts}`));
console.log("watching; Ctrl+C stops");
