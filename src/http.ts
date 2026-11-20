import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ROUTER_VERSION } from "./config.js";
import { createRouterServer, type RouterContext } from "./server.js";

/**
 * 对上游提供 Streamable HTTP(2025-03-26)服务,stateless 模式:
 * 每个请求创建独立 transport + McpServer 实例,共享同一份 RouterContext
 * (下游连接池 / 工具目录 / 统计),因此与 stdio 传输可并存且零相互影响。
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  // X-MCP-Token / Authorization: Bearer / ?token= 三种客户端传 token 方式都要放行
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-MCP-Token, X-Requested-With",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

// 按 MCP 请求处理的 HTTP 方法(目前仅 POST;进入此分支的请求做 token 校验)
const MCP_HTTP_METHODS = new Set(["POST"]);

function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

/** 恒定时间比较,防时序侧信道;长度不等时也做一次等长比较避免短路泄漏 */
function tokenEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const custom = req.headers["x-mcp-token"];
  if (typeof custom === "string" && custom.length > 0) return custom.trim();
  const query = url.searchParams.get("token");
  if (query && query.length > 0) return query;
  return undefined;
}

function replyJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function reply401(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid token" }, id: null }));
}

function reply405(res: ServerResponse): void {
  res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
}

function reply404(res: ServerResponse): void {
  replyJson(res, 404, { error: "not found", hint: "MCP endpoint accepts POST /mcp; health check is GET /healthz" });
}

export interface HttpServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface StartHttpOptions {
  ctx: RouterContext;
  host: string;
  port: number;
  authToken?: string;
}

function localIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

export function startHttpServer(opts: StartHttpOptions): Promise<HttpServerHandle> {
  const { ctx, host, port, authToken } = opts;
  const authEnabled = Boolean(authToken);
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    // 顶层兜底:任何同步异常(如畸形请求行)只回应错误,绝不能变成 uncaughtException 杀掉整个进程
    // —— stdio 侧(both 模式)或下游子进程都依赖本进程存活
    try {
      applyCors(res);
      const started = Date.now();
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
        return;
      }
      const finishLog = (): void => {
        const ms = Date.now() - started;
        // 日志只记 pathname 不记 query:?token= 传参时避免把校验令牌写进日志
        console.error(`[mcp-router] http ${req.method} ${url.pathname} -> ${res.statusCode} (${ms}ms)`);
      };
      res.on("finish", finishLog);

      // CORS 预检:浏览器/网页类客户端需要
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // 健康探活:不校验 token,只暴露非敏感状态信息
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
        replyJson(res, 200, {
          service: "mcp-router",
          version: ROUTER_VERSION,
          transport: "http",
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          servers: ctx.downstreams.size,
          tools: ctx.registry.size,
          auth: authEnabled,
        });
        return;
      }

      // /mcp 是标准端点;但 POST 到任意路径都按 MCP 请求处理,兼容 URL 末尾少写 /mcp 的客户端
      if (MCP_HTTP_METHODS.has(req.method ?? "")) {
        if (authEnabled && !tokenEquals(authToken!, extractToken(req, url) ?? "")) {
          reply401(res);
          return;
        }
        handleMcpRequest(req, res, ctx);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        // stateless 模式不支持服务端推送流与会话终止,按规范返回 405
        if (url.pathname === "/mcp" || req.method === "DELETE") reply405(res);
        else reply404(res);
        return;
      }

      reply404(res);
    } catch (e) {
      console.error(`[mcp-router] http handler crashed (request rejected): ${String(e)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      } catch {
        // 响应已不可写,忽略
      }
    }
  });

  return new Promise<HttpServerHandle>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(
          new Error(
            `端口 ${port} 已被占用(EADDRINUSE)。请用 --port <其他端口> 更换,或关闭占用该端口的进程后重试。`
          )
        );
      } else {
        reject(e);
      }
    });
    server.listen(port, host, () => {
      console.error(`[mcp-router] v${ROUTER_VERSION} http listening on ${host}:${port}`);
      if (authEnabled) {
        console.error("[mcp-router] token 校验已启用: 客户端需携带 Authorization: Bearer <token> / X-MCP-Token 或 URL ?token=");
      }
      const ips = host === "0.0.0.0" ? localIps() : [host];
      for (const ip of ips) {
        console.error(`[mcp-router] 客户端接入: ${authEnabled ? `${ip}:${port}/mcp?token=<你的token>` : `http://${ip}:${port}/mcp`}`);
      }
      resolve({
        host,
        port,
        close: () =>
          new Promise<void>((closeResolve) => {
            // 立即断开 keep-alive 连接,避免 close() 挂等存量连接
            (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

/**
 * stateless 处理单个 MCP 请求:每请求新 transport + 新 McpServer 实例(注册 5 个元工具约亚毫秒),
 * 通过共享 ctx 复用下游连接池与工具目录;请求结束后随连接关闭一并回收。
 */
function handleMcpRequest(req: IncomingMessage, res: ServerResponse, ctx: RouterContext): void {
  void (async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createRouterServer(ctx);
    res.on("close", () => {
      void server.close().catch(() => {});
      void transport.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: `internal error: ${String(e)}` }, id: null }));
      } catch {
        // 连接已断开,无法写出响应,忽略
      }
      console.error(`[mcp-router] http request handling failed: ${String(e)}`);
    }
  })();
}
