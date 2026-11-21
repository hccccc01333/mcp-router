#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ROUTER_VERSION, errMsg, loadConfig, type RouterConfig } from "./config.js";
import { Downstream } from "./downstream.js";
import { startHttpServer, type HttpServerHandle } from "./http.js";
import { log, muteDownstreamLogs } from "./log.js";
import { ToolRegistry } from "./registry.js";
import { createRouterServer, type RouterContext } from "./server.js";
import { UsageStats } from "./stats.js";

function parseFlag(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function printUsage(): void {
  // 全部输出走 stderr:stdio 模式下 stdout 是 MCP 协议通道,不可污染
  console.error(`mcp-router v${ROUTER_VERSION} — 聚合多个下游 MCP Server 的能力路由器

用法: node dist/index.js [选项]

选项:
  --config, -c <path>       配置文件路径 (默认: ./mcp-router.config.json, 或环境变量 MCP_ROUTER_CONFIG)
  --transport <mode>        对上游提供服务的方式: stdio | http | both (默认: stdio; both 不推荐, 见 README)
  --host <addr>             HTTP 监听地址 (默认: 127.0.0.1; 局域网访问需 0.0.0.0)
  --port <n>                HTTP 监听端口 (默认: 7800)
  --auth-token <token>      HTTP 校验令牌; 未设置时不校验。也可写入配置文件 http.authToken (支持 \${ENV} 展开)
  --help, -h                显示本帮助

示例:
  stdio (默认, 与旧版完全一致):
    node dist/index.js --config mcp-router.config.json
  HTTP 局域网服务:
    node dist/index.js --transport http --host 0.0.0.0 --port 7800
  HTTP + 校验令牌:
    node dist/index.js --transport http --auth-token my-secret
  stdio 与 HTTP 同时提供 (共享下游连接池; 不推荐: 生命周期绑定, 见 README):
    node dist/index.js --transport both

HTTP 客户端接入: http://<ip>:<port>/mcp   (健康探活: GET /healthz)`);
}

async function warmupAll(config: RouterConfig, downstreams: Map<string, Downstream>, registry: ToolRegistry): Promise<void> {
  await Promise.allSettled(
    [...downstreams.values()].map(async (down) => {
      // 配置禁用的下游:跳过连接与加载,只留一行日志确认配置被识别
      if (down.status === "disabled") {
        log(`[mcp-router] ${down.name}: disabled, skipped`);
        return;
      }
      try {
        const tools = await down.listTools(config.timeouts.connectMs);
        registry.replaceServer(down.name, tools);
        log(`[mcp-router] ${down.name}: loaded ${tools.length} tool(s)`);
      } catch (e) {
        log(`[mcp-router] ${down.name}: warm-up failed - ${errMsg(e)}`);
      }
    })
  );
  const enabled = [...downstreams.values()].filter((down) => down.status !== "disabled").length;
  const skipped = downstreams.size - enabled;
  log(`[mcp-router] catalog ready: ${registry.size} tool(s) from ${enabled} server(s)${skipped > 0 ? ` (${skipped} disabled)` : ""}`);
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return;
  }
  const config = loadConfig(parseFlag("--config") ?? parseFlag("-c"));

  const transport = parseFlag("--transport") ?? "stdio";
  if (transport !== "stdio" && transport !== "http" && transport !== "both") {
    throw new Error(`--transport 只支持 stdio | http | both (got ${JSON.stringify(transport)})`);
  }

  const host = parseFlag("--host") ?? config.http?.host ?? "127.0.0.1";
  const authToken = parseFlag("--auth-token") ?? config.http?.authToken;
  let port = config.http?.port ?? 7800;
  const portArg = parseFlag("--port");
  if (portArg !== undefined) {
    const n = Number(portArg);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`--port 需要 1-65535 之间的整数 (got ${JSON.stringify(portArg)})`);
    }
    port = n;
  }

  const downstreams = new Map<string, Downstream>();
  for (const [name, spec] of Object.entries(config.mcpServers)) {
    downstreams.set(name, new Downstream(name, spec));
  }
  const registry = new ToolRegistry();
  const stats = new UsageStats();

  // 各传输共享同一份 ctx(下游连接池/工具目录/统计);
  // 注意 both 模式下两条传输生命周期绑定,且共用同一批下游连接,连接级故障会同时影响两条传输
  const ctx: RouterContext = {
    config,
    downstreams,
    registry,
    warmup: warmupAll(config, downstreams, registry),
    stats,
  };

  let httpHandle: HttpServerHandle | undefined;
  if (transport !== "stdio") {
    httpHandle = await startHttpServer({ ctx, host, port, authToken });
  }
  let closeStdio: (() => Promise<void>) | undefined;
  if (transport !== "http") {
    const stdioServer = createRouterServer(ctx);
    await stdioServer.connect(new StdioServerTransport());
    closeStdio = () => stdioServer.close();
    log(`[mcp-router] v${ROUTER_VERSION} listening on stdio`);
  }

  // 停机语义(所有模式一致):任何退出信号都优雅关闭本进程持有的全部资源。
  // - stdio/both: Agent 关闭 stdin(stdio 写端) 即退出整个进程(含 HTTP 监听),避免 Agent 重启后旧进程占住端口
  // - http: Ctrl+C / SIGTERM / 关闭窗口 触发退出
  // 注意:http 与 stdio 是同一进程内的两条传输(共享下游连接池),进程退出即整体退出,无法"只死一半";
  // 若需要"关掉 HTTP 不影响正在使用的 stdio 会话",请用两个独立进程:
  //   常驻服务 --transport http, TraeCode 用 --transport stdio(由 Agent 拉起),各自持有独立的下游连接。
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[mcp-router] ${reason}, shutting down gracefully...`);
    // 静默下游 stderr 转发:Ctrl+C 广播同时打断下游进程(如 Python 打印 KeyboardInterrupt 堆栈),
    // 此后这些输出经 pipe 到达时不再刷屏;router 自身日志不受影响
    muteDownstreamLogs();
    void (async () => {
      // 兜底:极端情况下仍有句柄残留时强制退出,不阻塞事件循环收尾
      const forceExit = setTimeout(() => {
        log("[mcp-router] shutdown timed out after 5s, forcing exit");
        process.exit(0);
      }, 5000);
      forceExit.unref();
      if (closeStdio) await closeStdio().catch(() => {});
      if (httpHandle) {
        const handle = httpHandle;
        httpHandle = undefined;
        await handle.close().catch(() => {});
        log(`[mcp-router] http listener closed (${handle.host}:${handle.port})`);
      }
      await Promise.allSettled([...downstreams.values()].map((down) => down.close()));
      log("[mcp-router] all downstream connections closed, bye.");
    })();
  };
  if (transport !== "http") {
    // SDK 的 StdioServerTransport 不会监听 stdin EOF(它只在显式 close() 时触发 onclose)。
    process.stdin.on("end", () => shutdown("stdin closed by agent"));
    process.stdin.on("close", () => shutdown("stdin closed by agent"));
  }
  // 信号处理对所有模式生效:stdio 模式下 Agent 发 SIGTERM 时也能优雅关闭,
  // 否则进程瞬死会把这些下游子进程留成孤儿(Linux/Windows 都不会自动回收)
  process.on("SIGINT", () => shutdown("Ctrl+C received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
  process.on("SIGHUP", () => shutdown("terminal closed"));
}

process.on("unhandledRejection", (reason) => {
  log(`[mcp-router] unhandled rejection: ${String(reason)}`);
});

main().catch((e) => {
  log(`[mcp-router] fatal: ${errMsg(e)}`);
  process.exit(1);
});
