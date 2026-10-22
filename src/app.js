// Stops and starts the Slack desktop app with or without the DevTools port: the Linux
// flatpak or native package, the macOS app, or the Windows installer build.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLATPAK = "com.slack.Slack";

const succeeds = (cmd, args) => run(cmd, args).then(() => true, () => false);
const launch = (cmd, args) => spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();

const apps = {
  flatpak: {
    name: "Slack flatpak",
    stop: () => run("flatpak", ["kill", FLATPAK]),
    running: async () => (await run("flatpak", ["ps", "--columns=application"])).stdout.split("\n").some((l) => l.trim() === FLATPAK),
    start: (args) => launch("flatpak", ["run", FLATPAK, ...args]),
  },
  linux: {
    name: "Slack (native Linux)",
    stop: () => run("pkill", ["-x", "slack"]),
    running: () => succeeds("pgrep", ["-x", "slack"]),
    start: (args) => launch("slack", args),
  },
  darwin: {
    name: "Slack.app",
    stop: () => run("osascript", ["-e", 'quit app "Slack"']),
    running: () => succeeds("pgrep", ["-x", "Slack"]),
    start: (args) => launch("open", ["-a", "Slack", "--args", ...args]),
  },
  win32: {
    name: "Slack for Windows",
    exe: join(process.env.LOCALAPPDATA ?? "", "slack", "slack.exe"),
    stop: () => run("taskkill", ["/IM", "slack.exe", "/F"]),
    running: async () => (await run("tasklist", ["/FI", "IMAGENAME eq slack.exe", "/NH"])).stdout.toLowerCase().includes("slack.exe"),
    start: (args) => launch(apps.win32.exe, args),
  },
};

// The Slack install this machine has, as { name, stop, running, start(args) }, or null.
export async function detectApp() {
  if (process.platform === "darwin") return apps.darwin;
  if (process.platform === "win32") return existsSync(apps.win32.exe) ? apps.win32 : null;
  if (await succeeds("flatpak", ["info", FLATPAK])) return apps.flatpak;
  if (await succeeds("which", ["slack"])) return apps.linux;
  return null;
}

// Quits Slack and starts it again; with port, listening for DevTools on 127.0.0.1:port.
// ready resolves true once the port answers.
export async function restartSlack({ port = null, ready = async () => true } = {}) {
  const app = await detectApp();
  if (!app) throw new Error("couldn't find the Slack desktop app; start it yourself with --remote-debugging-port");
  await app.stop().catch(() => {});
  for (let i = 0; i < 20 && (await app.running().catch(() => false)); i++) await sleep(500);

  app.start(port ? [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] : []);
  if (!port) return;

  for (let i = 0; i < 60; i++) {
    if (await ready()) return;
    await sleep(1000);
  }
  throw new Error(`${app.name} didn't open port ${port} within 60 s`);
}
