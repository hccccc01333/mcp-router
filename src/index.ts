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
}

process.on("unhandledRejection", (reason) => {
  console.error(`[mcp-router] unhandled rejection: ${String(reason)}`);
});

main().catch((e) => {
  console.error(`[mcp-router] fatal: ${errMsg(e)}`);
  process.exit(1);
});
