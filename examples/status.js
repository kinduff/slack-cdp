// Shows your status, or sets it for an hour: node examples/status.js [":emoji:" "text"]
import { connect } from "../index.js";

const slack = await connect();
const [emoji, text] = process.argv.slice(2);
if (emoji) await slack.setStatus({ emoji, text: text ?? "", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
console.log(await slack.getStatus());
await slack.close();
