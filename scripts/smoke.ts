import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errMsg, loadConfig } from "../src/config.js";
import { Downstream } from "../src/downstream.js";
import { ToolRegistry } from "../src/registry.js";
import { META_TOOL_NAMES, createRouterServer } from "../src/server.js";
import { UsageStats } from "../src/stats.js";

function bodyOf(res: CallToolResult): string {
  return (res.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

async function buildEchoDownstream(): Promise<Downstream> {
  const echoServer = new McpServer({ name: "echo-downstream", version: "0.1.0" });
  echoServer.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo back the provided text, useful for verifying the router pipeline end to end.",
      inputSchema: { text: z.string().describe("Text to echo back") },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  );
  echoServer.registerTool(
    "add_numbers",
    {
      title: "Add numbers",
      description: "Add two numbers together and return the sum.",
      inputSchema: { a: z.number().describe("First addend"), b: z.number().describe("Second addend") },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await echoServer.connect(serverTransport);
  return new Downstream("echo", { command: "noop" }, clientTransport);
}

async function main(): Promise<void> {
  const config = {
    mcpServers: {},
    timeouts: { connectMs: 5000, callMs: 5000 },
    maxResultChars: 4000,
  };
  const downstream = await buildEchoDownstream();
  const tools = await downstream.listTools(config.timeouts.connectMs);
  if (tools.length !== 2) throw new Error(`expected 2 tools on echo downstream, got ${tools.length}`);

  const registry = new ToolRegistry();
  registry.replaceServer(downstream.name, tools);
  const downstreams = new Map([[downstream.name, downstream]]);
  const stats = new UsageStats();
  const router = createRouterServer({ config, downstreams, registry, warmup: Promise.resolve(), stats });

  const [routerServerTransport, routerClientTransport] = InMemoryTransport.createLinkedPair();
  await router.connect(routerServerTransport);
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await client.connect(routerClientTransport);

  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    if (ok) {
      passed++;
      console.log(`PASS ${label}`);
    } else {
      failures.push(label);
      console.error(`FAIL ${label}${detail ? ` - ${detail}` : ""}`);
    }
  };

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  check(
    "router exposes exactly the 5 meta-tools",
    JSON.stringify(names) === JSON.stringify([...META_TOOL_NAMES].sort()),
    names.join(", ")
  );

  const browse = await client.callTool({ name: "search_tools", arguments: { query: "" } });
  check("empty query browses full catalog", bodyOf(browse).includes("Tool catalog: 2"), bodyOf(browse));

  const search = await client.callTool({ name: "search_tools", arguments: { query: "add two numbers sum" } });
  check("keyword search finds add_numbers", bodyOf(search).includes("echo::add_numbers"), bodyOf(search));

  const searchEcho = await client.callTool({ name: "search_tools", arguments: { query: "echo text" } });
  check("keyword search ranks echo first", bodyOf(searchEcho).indexOf("echo::echo") < bodyOf(searchEcho).indexOf("echo::add_numbers"), bodyOf(searchEcho));

  const noHit = await client.callTool({ name: "search_tools", arguments: { query: "zzzz_no_such_capability" } });
  check("no match reports gracefully", bodyOf(noHit).includes("No tools matched"));

  const schema = await client.callTool({ name: "get_tool_schema", arguments: { id: "echo::add_numbers" } });
  const schemaBody = bodyOf(schema);
  check("schema exposes properties", schemaBody.includes('"a"') && schemaBody.includes('"number"'), schemaBody);

  const badSchema = await client.callTool({ name: "get_tool_schema", arguments: { id: "echo::nope" } });
  check("unknown schema id errors with suggestions", badSchema.isError === true && bodyOf(badSchema).includes("Did you mean"), bodyOf(badSchema));

  const exec = await client.callTool({
    name: "execute_tool",
    arguments: { id: "echo::add_numbers", arguments: { a: 2, b: 40 } },
  });
  check("execute routes and returns 42", bodyOf(exec).includes("42") && exec.isError !== true, bodyOf(exec));

  const badExec = await client.callTool({ name: "execute_tool", arguments: { id: "echo::missing" } });
  check("unknown execute id errors", badExec.isError === true, bodyOf(badExec));

  const servers = await client.callTool({ name: "list_servers", arguments: {} });
  const serversBody = bodyOf(servers);
  check("list_servers shows connected status", serversBody.includes("echo") && serversBody.includes("connected") && serversBody.includes("2 tools"), serversBody);

  const statsRes = await client.callTool({ name: "tool_stats", arguments: {} });
  const statsBody = bodyOf(statsRes);
  check(
    "tool_stats records searches, schema views and calls",
    statsBody.includes("Totals:") &&
      statsBody.includes("echo::add_numbers") &&
      /1 tool calls, 0 errors/.test(statsBody),
    statsBody
  );

  // --- SSE 下游:真实 localhost HTTP+SSE 链路 ---
  {
    const sseMcp = new McpServer({ name: "sse-echo-downstream", version: "0.1.0" });
    sseMcp.registerTool(
      "sse_add",
      {
        title: "SSE Add numbers",
        description: "Add two numbers over the legacy SSE transport, verifying mcp-router SSE downstream support.",
        inputSchema: { a: z.number().describe("First addend"), b: z.number().describe("Second addend") },
      },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
    );

    let sseTransport: SSEServerTransport | undefined;
    const httpServer = createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/sse") {
          sseTransport = new SSEServerTransport("/messages", res);
          await sseMcp.connect(sseTransport);
        } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
          if (!sseTransport) {
            res.writeHead(400).end();
            return;
          }
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(404).end();
        }
      })().catch((e) => res.destroy(e instanceof Error ? e : undefined));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const ssePort = (httpServer.address() as { port: number }).port;

    const sseDown = new Downstream("sse-echo", {
      url: `http://127.0.0.1:${ssePort}/sse`,
      headers: { "X-Router-Test": "sse" },
      type: "sse",
    });
    check("sse downstream reports kind as sse", sseDown.kind === "sse", sseDown.kind);

    const sseTools = await sseDown.listTools(5000);
    check(
      "sse downstream lists tools over legacy HTTP+SSE transport",
      sseTools.some((t) => t.name === "sse_add") && sseDown.status === "connected",
      `status=${sseDown.status}, tools=${sseTools.map((t) => t.name).join(",")}`
    );

    const sseCall = await sseDown.callTool(5000, "sse_add", { a: 20, b: 22 });
    check(
      "sse downstream executes tool round-trip",
      bodyOf(sseCall).includes("42") && !sseCall.isError,
      bodyOf(sseCall)
    );

    await sseDown.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  // --- 配置 type 字段解析 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "mcp-router-smoke-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        timeouts: { connectMs: 5000, callMs: 5000 },
        maxResultChars: 4000,
        mcpServers: {
          legacy: { type: "sse", url: "https://example.com/sse", headers: { "X-A": "b" } },
          plain: { url: "https://example.com/mcp" },
          explicit: { type: "streamable-http", url: "https://example.com/api" },
          local: { type: "stdio", command: "node" },
        },
      })
    );
    const cfg = loadConfig(configPath);
    const legacy = cfg.mcpServers.legacy;
    check(
      'config parses "type": "sse" into sse downstream with headers kept',
      "url" in legacy && legacy.type === "sse" && legacy.headers?.["X-A"] === "b",
      JSON.stringify(legacy)
    );
    const plain = cfg.mcpServers.plain;
    const explicit = cfg.mcpServers.explicit;
    const local = cfg.mcpServers.local;
    check(
      'config defaults url entries to streamable http ("http"/"streamable-http" normalize away)',
      "url" in plain && plain.type === undefined && "url" in explicit && explicit.type === undefined,
      `plain=${JSON.stringify(plain)} explicit=${JSON.stringify(explicit)}`
    );
    check('config accepts explicit "type": "stdio"', "command" in local && local.command === "node", JSON.stringify(local));

    writeFileSync(configPath, JSON.stringify({ mcpServers: { bad: { type: "ws", url: "https://example.com" } } }));
    let rejected = false;
    try {
      loadConfig(configPath);
    } catch (e) {
      rejected = errMsg(e).includes("must be one of");
    }
    check("config rejects unknown type values", rejected);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
