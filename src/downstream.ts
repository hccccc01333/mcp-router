import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ROUTER_VERSION, errMsg, type DownstreamSpec, type HttpDownstream, type StdioDownstream } from "./config.js";
import { forwardDownstreamStderr } from "./log.js";

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

// 接管 stderr 后下游拿到的是管道而非控制台句柄:Python 会退回本机代码页(GBK/cp1252),
// 编码不了的字符(框线/emoji)被 backslashreplace 成 "\u2580" 之类的字面量,再按 UTF-8 解码即成乱码。
// 强制 Python 的 stdio 使用 UTF-8,保证经管道传输的字节可被无损还原;下游配置里显式设置的 env 优先。
const UTF8_STDIO_ENV: Record<string, string> = { PYTHONIOENCODING: "utf-8" };

function mergedEnv(extra?: Record<string, string>): Record<string, string> {
  // 仅当用户配置了 env 时才传递完整父进程环境(与原行为一致)
  const base: Record<string, string> = {};
  if (extra) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) base[key] = value;
    }
  }
  return { ...base, ...UTF8_STDIO_ENV, ...extra };
}

export type DownstreamStatus = "idle" | "connecting" | "connected" | "error" | "disabled";

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
    // 配置显式禁用:不连接、不加载工具;保留实例以便 list_servers 显示 disabled 状态
    if (spec.disabled === true) this.status = "disabled";
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
    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      cwd: s.cwd,
      env: mergedEnv(s.env),
      // stderr 接管而非直写控制台:保留 shutdown 时静默下游异常堆栈的能力;
      // 正常期按 UTF-8 流式解码后转发(不逐块加前缀),保留多行排版与多字节字符。
      // 代价:下游看到的是管道而非控制台,依赖 TTY 判断的颜色/进度条渲染会降级为纯文本
      stderr: "pipe",
    });
    // SDK 在 pipe 模式下立即返回 PassThrough,构造后即可挂监听,不丢启动期输出;
    // StringDecoder 会缓存不完整的多字节序列,避免一个汉字被切成两块时出现乱码
    const decoder = new StringDecoder("utf8");
    transport.stderr?.on("data", (chunk: Buffer) => {
      forwardDownstreamStderr(decoder.write(chunk));
    });
    return transport;
  }

  getClient(timeoutMs: number): Promise<Client> {
    // disabled 是防御路径:正常流程 warmup 已跳过、registry 无其工具,不会被调用
    if (this.status === "disabled") {
      return Promise.reject(new Error(`downstream "${this.name}" is disabled by config`));
    }
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
      // 只有连接级失败(连接关闭/请求超时)才值得重连重试;
      // 下游返回的业务错误(工具不存在/参数非法/内部错误等)说明连接健康,重试毫无意义,
      // 还会关掉与另一条传输(如 both 模式的 stdio 调用)共用的连接,并可能让已产生副作用的工具重复执行
      if (e instanceof McpError && e.code !== ErrorCode.ConnectionClosed && e.code !== ErrorCode.RequestTimeout) {
        throw e;
      }
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
    // disabled 不可被 close 覆盖回 idle:禁用是配置属性,不是运行状态
    if (this.status !== "error" && this.status !== "disabled") this.status = "idle";
  }
}
