// Prints every new message, live: node examples/tail.js
import { connect, mentions, plainText } from "../index.js";

const slack = await connect();
const teams = new Map((await slack.workspaces()).map((w) => [w.id, w.name]));
process.on("SIGINT", () => slack.close().then(() => process.exit(0)));

for await (const m of slack.messages()) {
  const opts = { team: m.team };
  const names = new Map(await Promise.all(mentions(m.text).map(async (id) => [id, await slack.userName(id, opts)])));
  const where = `${teams.get(m.team) ?? m.team} ${await slack.place(m.channel, opts)}`;
  console.log(`${where} ${await slack.userName(m.user, opts)}: ${plainText(m.text, (id) => names.get(id) ?? id)}`);
}
