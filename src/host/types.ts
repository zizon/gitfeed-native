/** Structural types for the Harness services this Host plugin uses. */

import type { ReaderPrefs } from "../shared/types.js";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>;
}

export interface WebServer {
  register(route: WebRoute): () => void;
}

export interface ToolOutputDefinition {
  schema: Record<string, unknown>;
  render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: ToolOutputDefinition;
  execute(args: unknown): Promise<unknown>;
}

export interface Tools {
  register(definition: ToolDefinition): () => void;
}

export interface PluginContext {
  logger: Logger;
  webServer: WebServer;
  effect(callback: () => (() => void) | void, label?: string): () => void;
  inject(services: string[], callback: (ctx: PluginContext & { tools: Tools }) => void): void;
}

export interface GitfeedConfig {
  repo?: string;
  refreshMinutes?: number;
  idleMinutes?: number;
  allowGit?: boolean;
  tool?: boolean;
}

export interface RepoConfig {
  fetch: {
    concurrency: number;
    timeoutMs: number;
    keepMonths: number;
    maxSummaryChars: number;
  };
  reader: ReaderPrefs;
}

export interface FeedDefinition {
  id: string;
  url: string;
  title: string | null;
  folder: string | null;
}

export interface FetchResult {
  code: number;
  logs: string[];
  summary: string;
  feeds: number;
  fresh: number;
  unchanged: number;
  expired: number;
  failed: number;
}

export interface GitActionResult {
  ok: boolean;
  action: string;
  output?: string;
  error?: string;
  committed?: boolean;
}

export interface ReaderStateData {
  items: import("../shared/types.js").Item[];
  read: string[];
  starred: string[];
  feeds: import("../shared/types.js").Feed[];
  reader: ReaderPrefs;
  repo: string;
  allowGit: boolean;
}

export interface ReadyState extends ReaderStateData {
  version: string;
  unchanged?: boolean;
  git: import("../shared/types.js").GitInfo | null;
  localFetch: import("../shared/types.js").LocalFetchInfo;
  generatedAt: string;
  error?: string;
}
