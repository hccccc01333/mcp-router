import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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
  // .exe 可直接 spawn;.cmd/.bat 是批处理脚本,npx/npm 等无扩展名脚本由 cmd 解析 —— 都必须经 cmd.exe 执行
  const needsCmd = !/\.exe$/.test(bare) && (WRAPPABLE_ON_WINDOWS.has(bare) || /\.(cmd|bat)$/.test(bare));
  if (needsCmd) {
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
  private transport?: Transport;
  private connecting?: Promise<Client>;

  constructor(name: string, spec: DownstreamSpec, transportOverride?: Transport) {
    this.name = name;
    this.spec = spec;
    this.transportOverride = transportOverride;
  }

  get kind(): "stdio" | "http" | "sse" {
    if ("url" in this.spec) {
      return (this.spec as HttpDownstream).type === "sse" ? "sse" : "http";
    }
    return "stdio";
  }

  get target(): string {
    if ("url" in this.spec) return this.spec.url;
    const s = this.spec as StdioDownstream;
    return [s.command, ...(s.args ?? [])].join(" ");
  }

  private buildTransport(): Transport {
    if ("url" in this.spec) {
      const s = this.spec as HttpDownstream;
      const options = s.headers ? { requestInit: { headers: s.headers } } : undefined;
      // "sse":旧版 HTTP+SSE 传输(2024-11-05 协议);缺省走 Streamable HTTP
      if (s.type === "sse") {
        return new SSEClientTransport(new URL(s.url), options);
      }
      return new StreamableHTTPClientTransport(new URL(s.url), options);
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
        const client = new Client({ name: "mcp-router", version: ROUTER_VERSION });
        const transport = this.transportOverride ?? this.buildTransport();
        try {
          await withTimeout(client.connect(transport), timeoutMs, `connect(${this.name})`);
          this.client = client;
          this.transport = transport;
          this.status = "connected";
          this.lastError = undefined;
          return client;
        } catch (e) {
          // 失败/超时的连接必须关闭底层 transport,否则 stdio 子进程会泄漏
          void client.close().catch(() => {});
          this.transport = undefined;
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
    // 若有进行中的连接,等它落定:成功则一并关闭(否则握手完成后会残留子进程),失败已由 getClient 清理
    if (this.connecting) {
      await this.connecting.catch(() => {});
    }
    const client = this.client;
    this.client = undefined;
    const transport = this.transport;
    this.transport = undefined;
    // Streamable HTTP 会话按规范(SHOULD)先以 DELETE 显式终止;服务器不支持时回 405,失败不阻断后续关闭
    if (transport) {
      try {
        await (transport as { terminateSession?: () => Promise<void> }).terminateSession?.();
      } catch {
        // 忽略:无会话/网络错误/405 均可安全跳过
      }
    }
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
