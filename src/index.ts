#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ROUTER_VERSION, errMsg, loadConfig, type RouterConfig } from "./config.js";
import { Downstream } from "./downstream.js";
import { ToolRegistry } from "./registry.js";
import { createRouterServer } from "./server.js";
import { UsageStats } from "./stats.js";

function parseFlag(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function warmupAll(config: RouterConfig, downstreams: Map<string, Downstream>, registry: ToolRegistry): Promise<void> {
  await Promise.allSettled(
    [...downstreams.values()].map(async (down) => {
      try {
        const tools = await down.listTools(config.timeouts.connectMs);
        registry.replaceServer(down.name, tools);
        console.error(`[mcp-router] ${down.name}: loaded ${tools.length} tool(s)`);
      } catch (e) {
        console.error(`[mcp-router] ${down.name}: warm-up failed - ${errMsg(e)}`);
      }
    })
  );
  console.error(`[mcp-router] catalog ready: ${registry.size} tool(s) from ${downstreams.size} server(s)`);
}

async function main(): Promise<void> {
  const config = loadConfig(parseFlag("--config") ?? parseFlag("-c"));
  const downstreams = new Map<string, Downstream>();
  for (const [name, spec] of Object.entries(config.mcpServers)) {
    downstreams.set(name, new Downstream(name, spec));
  }
  const registry = new ToolRegistry();
  const stats = new UsageStats();

  const server = createRouterServer({
    config,
    downstreams,
    registry,
    warmup: warmupAll(config, downstreams, registry),
    stats,
  });
  await server.connect(new StdioServerTransport());
  console.error(`[mcp-router] v${ROUTER_VERSION} listening on stdio`);
  // SDK 的 StdioServerTransport 不会监听 stdin EOF(它只在显式 close() 时触发 onclose)。
  // Agent 退出/关闭写端后这里手动停机:关闭协议层和全部下游,回收子进程/连接,
  // 并让事件循环自然退出(否则 stdio 子进程句柄会使进程挂住,产生孤儿进程)。
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await server.close().catch(() => {});
      await Promise.allSettled([...downstreams.values()].map((down) => down.close()));
    })();
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

process.on("unhandledRejection", (reason) => {
  console.error(`[mcp-router] unhandled rejection: ${String(reason)}`);
});

main().catch((e) => {
  console.error(`[mcp-router] fatal: ${errMsg(e)}`);
  process.exit(1);
});
