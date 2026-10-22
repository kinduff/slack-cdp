# Changelog

## Unreleased

## 0.1.0

- Library: `connect()`, any Web API method through the app's session, messages, edits,
  deletes, reactions and raw events off the page's websocket, reconnects.
- Helpers: post, reply, update, delete, react, upload, open DMs, history, search,
  conversations, lookups by name and email, status, pagination.
- Channel references: IDs, `#name`, `@person`. Workspace references: IDs or name prefixes.
- `doctor()`, launching Slack with the port on Linux (flatpak, native), macOS and Windows.
- `slack-cdp` CLI: doctor, workspaces, tail, send, history, search, api, mcp.
- MCP server with workspaces, conversations, history, search, send, react and inbox tools.
- TypeScript types.
