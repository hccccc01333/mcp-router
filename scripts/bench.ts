import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Downstream } from "../src/downstream.js";
import { ToolRegistry } from "../src/registry.js";
import { createRouterServer } from "../src/server.js";
import { UsageStats } from "../src/stats.js";

// 生成一个挂载 N 个工具的伪 MCP Server，工具名多样以模拟真实下游。
async function buildDownstream(name: string, n: number): Promise<Downstream> {
  const server = new McpServer({ name, version: "0.1.0" });
  const domains = ["github", "jira", "gitlab", "sentry", "slack", "postgres", "redis", "kafka"];
  const verbs = ["create", "get", "update", "delete", "list", "search", "run", "execute", "send", "fetch"];
  for (let i = 0; i < n; i++) {
    const t = `tool_${i}`;
    server.registerTool(
      t,
      {
        title: `${verbs[i % verbs.length]}_${domains[i % domains.length]}_${i}`,
        description: `Performs ${verbs[i % verbs.length]} on ${domains[i % domains.length]} resource #${i}.`,
        inputSchema: { id: z.number().describe("resource id") },
      },
      async ({ id }) => ({ content: [{ type: "text", text: String(id) }] })
    );
  }
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return new Downstream(name, { command: "noop" }, clientTransport);
}

async function benchForSizes(sizes: number[], queries: string[]): Promise<void> {
  for (const n of sizes) {
    // 用 3 个伪下游均匀摊分工具，覆盖多 server 情形
    const names = ["bench-1", "bench-2", "bench-3"];
    const downstream = await buildDownstream(names[0], n);
    const registry = new ToolRegistry();
    registry.replaceServer(names[0], await downstream.listTools(10000));

    const downstreams = new Map([[names[0], downstream]]);
    const stats = new UsageStats();
    const router = createRouterServer({
      config: { mcpServers: {}, timeouts: { connectMs: 10000, callMs: 50000 }, maxResultChars: 20000 },
      downstreams,
      registry,
      warmup: Promise.resolve(),
      stats,
    });

    const [routerServerTransport, routerClientTransport] = InMemoryTransport.createLinkedPair();
    await router.connect(routerServerTransport);
    const client = new Client({ name: "bench-client", version: "0.0.0" });
    await client.connect(routerClientTransport);

    // warmup（触发初始化/预热路径）
    await client.callTool({ name: "search_tools", arguments: { query: "github" } });

    const perQuery: number[] = [];
    for (const q of queries) {
      const times: number[] = [];
      for (let i = 0; i < 50; i++) {
        let started = performance.now();
        await client.callTool({ name: "search_tools", arguments: { query: q, limit: 8 } });
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
      const p95 = times[Math.floor(times.length * 0.95)].toFixed(2);
      perQuery.push(Number(avg));
      console.log(`[N=${String(n).padStart(4)}] query="${q.padEnd(12)}" avg=${avg}ms p95=${p95}ms (50 runs)`);
    }
    await client.close();
  }
}

async function main(): Promise<void> {
  const sizes = [100, 500, 1000];
  const queries = ["github", "create", "postgres fetch", "zzz_no_match"];
  console.log("# MCP Router search_latency benchmark (InMemory transport, real MCP protocol)\n");
  await benchForSizes(sizes, queries);
}

main().catch((e) => {
  console.error("benchmark crashed:", e);
  process.exit(1);
});