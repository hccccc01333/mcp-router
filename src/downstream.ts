import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { ROUTER_VERSION, errMsg, type DownstreamSpec, type HttpDownstream, type StdioDownstream } from "./config.js";

const WRAPPABLE_ON_WINDOWS = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "uv"]);

function comSpec(): string {
  const fromEnv = process.env.ComSpec;
  if (fromEnv) return fromEnv;
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
}

function wrapWindowsCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  const bare = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!/\.(exe|cmd|bat)$/.test(bare) && WRAPPABLE_ON_WINDOWS.has(bare)) {
    return { command: comSpec(), args: ["/c", command, ...args] };
  }
  return { command, args };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergedEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined;
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}

export type DownstreamStatus = "idle" | "connecting" | "connected" | "error";

export class Downstream {
  readonly name: string;
  readonly spec: DownstreamSpec;
  status: DownstreamStatus = "idle";
  lastError?: string;
  private client?: Client;
  private transportOverride?: Transport;
  private connecting?: Promise<Client>;

  constructor(name: string, spec: DownstreamSpec, transportOverride?: Transport) {
    this.name = name;
    this.spec = spec;
    this.transportOverride = transportOverride;
  }

  get kind(): "stdio" | "http" {
    return "url" in this.spec ? "http" : "stdio";
  }

  get target(): string {
    if ("url" in this.spec) return this.spec.url;
    const s = this.spec as StdioDownstream;
    return [s.command, ...(s.args ?? [])].join(" ");
  }

  private buildTransport(): Transport {
    if ("url" in this.spec) {
      const s = this.spec as HttpDownstream;
      return new StreamableHTTPClientTransport(new URL(s.url), s.headers ? { requestInit: { headers: s.headers } } : undefined);
    }
    const s = this.spec as StdioDownstream;
    const wrapped = wrapWindowsCommand(s.command, s.args ?? []);
    return new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      cwd: s.cwd,
      env: mergedEnv(s.env),
    });
  }

  getClient(timeoutMs: number): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.status = "connecting";
      this.connecting = (async () => {
        try {
          const client = new Client({ name: "mcp-router", version: ROUTER_VERSION });
          await withTimeout(client.connect(this.transportOverride ?? this.buildTransport()), timeoutMs, `connect(${this.name})`);
          this.client = client;
          this.status = "connected";
          this.lastError = undefined;
          return client;
        } catch (e) {
          this.status = "error";
          this.lastError = errMsg(e);
          throw e;
        } finally {
          this.connecting = undefined;
        }
      })();
    }
    return this.connecting;
  }

  async listTools(timeoutMs: number): Promise<Tool[]> {
    const client = await this.getClient(timeoutMs);
    const res = await withTimeout(client.listTools(), timeoutMs, `tools/list(${this.name})`);
    return res.tools;
  }

  async callTool(timeoutMs: number, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const attempt = async (): Promise<CallToolResult> => {
      const client = await this.getClient(timeoutMs);
      const res = await withTimeout(client.callTool({ name, arguments: args ?? {} }), timeoutMs, `tools/call(${this.name}.${name})`);
      return res as CallToolResult;
    };
    try {
      return await attempt();
    } catch (e) {
      if (this.client && !this.transportOverride) {
        await this.close();
        return attempt();
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.close();
      } catch {
        this.lastError = errMsg(new Error("close failed"));
      }
    }
    if (this.status !== "error") this.status = "idle";
  }
}
