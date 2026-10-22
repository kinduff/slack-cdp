import { EventEmitter } from "node:events";

/** A workspace ID ("T…") or a name prefix ("acme" for "Acme Corp"). Omitted: the workspace active in the app. */
export type Team = string | null;
/** A channel ID ("C…", "G…", "D…"), "#name" or "name" of a conversation you're in, "@person" or a user ID for their DM. */
export type ChannelRef = string;

export interface TeamOption {
  team?: Team;
}

export interface ConnectOptions {
  /** Default "127.0.0.1". */
  host?: string;
  /** DevTools port. Default 9222. */
  port?: number;
  /** Restart Slack with the port if it isn't open. close() then restarts it without. Default false. */
  launch?: boolean;
  /** Reattach after Slack goes away. Default true. */
  reconnect?: boolean;
  /** Milliseconds between reattach attempts. Default 5000. */
  reconnectDelay?: number;
}

export interface Workspace {
  id: string;
  name: string;
  url: string;
  /** Your user ID in this workspace. */
  userId: string;
  /** Active in the app: where calls without `team` go. */
  active: boolean;
  signedIn: boolean;
}

/** A new message from the websocket. */
export interface Message {
  team: string | null;
  channel: string;
  /** User ID, or the bot ID for bot messages. */
  user: string | null;
  bot: boolean;
  /** Sent by you, in any workspace. Check it so a bot doesn't answer itself. */
  self: boolean;
  /** Slack markup; see plainText(). */
  text: string;
  ts: string;
  /** The thread's parent ts, for replies and thread parents. */
  threadTs: string | null;
  /** File names. */
  files: string[];
}

/** A message read from history. */
export interface HistoryMessage {
  ts: string;
  user: string | null;
  bot: boolean;
  self: boolean;
  text: string;
  threadTs: string | null;
  replies: number;
  files: string[];
}

export interface Edit {
  team: string | null;
  channel: string;
  user: string | null;
  self: boolean;
  text: string;
  previousText: string | null;
  ts: string;
  threadTs: string | null;
}

export interface Delete {
  team: string | null;
  channel: string;
  user: string | null;
  self: boolean;
  /** What it said, when Slack sends it. */
  text: string | null;
  ts: string;
  threadTs: string | null;
}

export interface Reaction {
  team: string | null;
  channel: string;
  /** The message's ts. */
  ts: string;
  /** Who reacted. */
  user: string;
  self: boolean;
  /** Emoji name without colons. */
  name: string;
  added: boolean;
  /** Who wrote the message. */
  itemUser: string | null;
}

/** A raw Slack websocket event. */
export interface SlackEvent {
  type: string;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  name: string | null;
  /** The other person, for a DM. */
  user: string | null;
  im: boolean;
  mpim: boolean;
  private: boolean;
}

export interface User {
  id: string;
  /** Display name, else real name, else username. */
  name: string;
  username: string;
  realName: string | null;
  email: string | null;
  bot: boolean;
  deleted: boolean;
}

export interface SearchHit {
  channel: string | null;
  channelName: string | null;
  ts: string;
  user: string | null;
  username: string | null;
  text: string;
  permalink: string | null;
}

export interface Status {
  text: string;
  emoji: string;
  /** Unix seconds; 0 for never. */
  expiresAt: number;
}

export interface UploadedFile {
  id: string;
  name: string;
  permalink: string | null;
}

export interface SlackEvents {
  message: [Message];
  edit: [Edit];
  delete: [Delete];
  reaction: [Reaction];
  event: [SlackEvent];
  connect: [];
  disconnect: [];
  close: [];
}

export class SlackError extends Error {
  /** Slack's error code: "channel_not_found", "not_in_channel", "ratelimited", ... */
  code: string;
  /** Seconds, for rate limits. */
  retryAfter: number | null;
  /** The full error response, when there was one. */
  body: Record<string, unknown> | null;
}

export class Slack extends EventEmitter<SlackEvents> {
  static connect(options?: ConnectOptions): Promise<Slack>;
  /** True when connect() restarted Slack to open the port. */
  launched: boolean;
  readonly connected: boolean;

  /** Any Web API method's response body. Objects in params are sent as JSON. Throws SlackError when not ok. */
  api<T = Record<string, any>>(method: string, params?: Record<string, unknown>, options?: TeamOption): Promise<T>;
  /** Every item of a cursor-paginated method. key: the array to read; default the first array in the response. */
  paginate<T = Record<string, any>>(method: string, params?: Record<string, unknown>, options?: TeamOption & { key?: string }): AsyncGenerator<T>;
  /** Runs JavaScript in the Slack page and returns the (JSON-serializable) value. */
  evaluate<T = unknown>(expression: string): Promise<T>;

  workspaces(): Promise<Workspace[]>;
  selfIds(): Promise<string[]>;
  isSelf(userId: string | null): boolean;
  resolveChannel(ref: ChannelRef, options?: TeamOption): Promise<string>;

  /** Returns the message ts. Extra options (blocks, unfurl_links, ...) pass through to chat.postMessage. */
  postMessage(channel: ChannelRef, text: string, options?: TeamOption & { threadTs?: string } & Record<string, unknown>): Promise<string>;
  /** Replies in the message's thread, or starts one, in its workspace. */
  reply(message: Pick<Message, "channel" | "ts" | "threadTs" | "team">, text: string, options?: Record<string, unknown>): Promise<string>;
  updateMessage(channel: ChannelRef, ts: string, text: string, options?: TeamOption & Record<string, unknown>): Promise<void>;
  deleteMessage(channel: ChannelRef, ts: string, options?: TeamOption): Promise<void>;
  react(channel: ChannelRef, ts: string, name: string, options?: TeamOption): Promise<void>;
  /** The DM (one user) or group DM (several) with these users. Returns its channel ID. */
  openDM(users: string | string[], options?: TeamOption): Promise<string>;
  upload(
    channel: ChannelRef,
    options: TeamOption & { data?: string | Uint8Array; path?: string; filename?: string; title?: string; threadTs?: string; comment?: string },
  ): Promise<UploadedFile>;

  /** Newest first. With threadTs, that thread's replies. */
  history(channel: ChannelRef, options?: TeamOption & { limit?: number; oldest?: string; latest?: string; threadTs?: string }): Promise<HistoryMessage[]>;
  /** Slack search syntax: "deploy from:@max in:#general after:2026-01-01". */
  search(query: string, options?: TeamOption & { count?: number; sort?: "score" | "timestamp" }): Promise<SearchHit[]>;
  conversations(options?: TeamOption & { types?: string }): Promise<Conversation[]>;
  conversationInfo(channel: string, options?: TeamOption): Promise<Conversation>;
  /** A conversation you're in, by name. Lists are cached for five minutes. */
  channelByName(name: string, options?: TeamOption & { refresh?: boolean }): Promise<Conversation | null>;
  /** By display name, real name or username. Active people win. Cached for five minutes. */
  userByName(name: string, options?: TeamOption & { refresh?: boolean }): Promise<User | null>;
  userByEmail(email: string, options?: TeamOption): Promise<User | null>;
  /** Cached; the ID if it can't be read. */
  userName(id: string | null, options?: TeamOption): Promise<string>;
  /** "#general", "@Max", "@a, b, c"; cached. */
  place(channel: string, options?: TeamOption): Promise<string>;

  getStatus(options?: TeamOption): Promise<Status>;
  setStatus(status: Partial<Status>, options?: TeamOption): Promise<void>;
  clearStatus(options?: TeamOption): Promise<void>;

  /** New messages until close(). */
  messages(): AsyncGenerator<Message>;
  stream<K extends "message" | "edit" | "delete" | "reaction" | "event">(kind: K): AsyncGenerator<SlackEvents[K][0]>;
  /** restore (default: launched) restarts Slack without the DevTools port. */
  close(options?: { restore?: boolean }): Promise<void>;
}

export function connect(options?: ConnectOptions): Promise<Slack>;

export function parseFrame(payload: string): SlackEvent | null;
export function messageEvent(event: string | SlackEvent, me?: Set<string>): Message | null;
export function editEvent(event: string | SlackEvent, me?: Set<string>): Edit | null;
export function deleteEvent(event: string | SlackEvent, me?: Set<string>): Delete | null;
export function reactionEvent(event: string | SlackEvent, me?: Set<string>): Reaction | null;
/** User IDs mentioned as <@U…>, each once. */
export function mentions(text: string): string[];
/** Renders <@U…>, <#C…|name>, <!here>, <url|label> and entities as readable text. */
export function plainText(text: string, name?: (userId: string) => string): string;
export function unescape(text: string): string;

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}
/** Checks app, port, page, session, API params and auth, and says which link broke. */
export function doctor(options?: { host?: string; port?: number }): Promise<{ ok: boolean; checks: DoctorCheck[] }>;

export interface SlackApp {
  name: string;
  stop(): Promise<unknown>;
  running(): Promise<boolean>;
  start(args: string[]): void;
}
export function detectApp(): Promise<SlackApp | null>;
/** Quits and restarts Slack; with port, listening for DevTools on 127.0.0.1:port. */
export function restartSlack(options?: { port?: number | null; ready?: () => Promise<boolean> }): Promise<void>;

/** Runs the MCP server on stdio (or the given streams). */
export function serveMcp(options?: {
  connectOptions?: ConnectOptions;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (...args: unknown[]) => void;
}): { done: Promise<void>; stop(): Promise<void> };
