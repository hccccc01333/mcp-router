import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errMsg, loadConfig } from "../src/config.js";
import { Downstream } from "../src/downstream.js";
import { ToolRegistry } from "../src/registry.js";
import { META_TOOL_NAMES, createRouterServer } from "../src/server.js";
import { UsageStats } from "../src/stats.js";

// unknown + cast:不依赖 SDK 的 callTool() 联合返回类型,与 e2e 的 bodyOf 保持一致
function bodyOf(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? [])
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// WHATWG fetch 规范屏蔽了一批端口(fetch 抛 "bad port");本机动态端口池覆盖低位段,
// listen(0) 可能随机分到屏蔽端口,循环重试直到拿到 fetch 可用的端口
const BLOCKED_FETCH_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const listenSafePort = async (server: Server): Promise<number> => {
  for (let i = 0; i < 16; i++) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const candidate = (server.address() as { port: number }).port;
    if (BLOCKED_FETCH_PORTS.has(candidate)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      continue;
    }
    return candidate;
  }
  throw new Error("no fetch-safe port available for localhost HTTP smoke test");
};

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
    // WHATWG fetch 规范屏蔽了一批端口(fetch 抛 "bad port");本机动态端口池覆盖低位段,
    // listen(0) 可能随机分到屏蔽端口,listenSafePort 循环重试直到拿到 fetch 可用的端口
    const ssePort = await listenSafePort(httpServer);

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

  // --- Streamable HTTP 下游:真实 localhost 链路 + 规范 SHOULD 的 DELETE 会话终止 ---
  {
    const httpMcp = new McpServer({ name: "http-echo-downstream", version: "0.1.0" });
    httpMcp.registerTool(
      "http_add",
      {
        title: "HTTP Add numbers",
        description: "Add two numbers over Streamable HTTP, verifying mcp-router http downstream support and spec-recommended session termination.",
        inputSchema: { a: z.number().describe("First addend"), b: z.number().describe("Second addend") },
      },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
    );

    // 有状态会话:initialize 建新 transport,后续请求按 mcp-session-id 路由(官方 server-streamableHttp.ts 模式)
    const transports = new Map<string, StreamableHTTPServerTransport>();
    let deleteSeen = 0;
    const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk as Buffer));
        req.on("error", reject);
        req.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      });
    const httpServer = createServer((req, res) => {
      void (async () => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        if (req.method === "GET") {
          // 不提供 standalone GET 流;客户端 SDK 对 405 有专门处理(合法降级)
          res.writeHead(405).end();
          return;
        }
        const sessionId = req.headers["mcp-session-id"];
        const known = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
        if (known) {
          if (req.method === "DELETE") {
            // 规范:客户端不再需要会话时 SHOULD 发 DELETE 显式终止 —— 本段的核心断言点
            deleteSeen++;
            transports.delete(String(sessionId));
          }
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          await known.handleRequest(req, res, body);
          return;
        }
        if (req.method === "POST" && sessionId === undefined) {
          const body = await readJsonBody(req);
          if (isInitializeRequest(body)) {
            const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
            await httpMcp.connect(t);
            await t.handleRequest(req, res, body);
            if (t.sessionId) transports.set(t.sessionId, t);
            return;
          }
        }
        res.writeHead(400).end();
      })().catch((e) => res.destroy(e instanceof Error ? e : undefined));
    });
    const httpPort = await listenSafePort(httpServer);

    const httpDown = new Downstream("http-echo", { url: `http://127.0.0.1:${httpPort}/mcp`, headers: { "X-Router-Test": "http" } });
    check("http downstream reports kind as http (default streamable)", httpDown.kind === "http", httpDown.kind);

    const httpTools = await httpDown.listTools(5000);
    check(
      "http downstream lists tools over streamable http transport",
      httpTools.some((t) => t.name === "http_add") && httpDown.status === "connected",
      `status=${httpDown.status}, tools=${httpTools.map((t) => t.name).join(",")}`
    );

    const httpCall = await httpDown.callTool(5000, "http_add", { a: 21, b: 21 });
    check(
      "http downstream executes tool round-trip",
      bodyOf(httpCall).includes("42") && !httpCall.isError,
      bodyOf(httpCall)
    );

    await httpDown.close();
    check(
      "close() terminates streamable http session via DELETE (spec SHOULD)",
      deleteSeen === 1 && transports.size === 0,
      `deleteSeen=${deleteSeen}, sessions=${transports.size}`
    );

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

    writeFileSync(configPath, '{"mcpServers":{"__proto__":{"command":"node"}}}');
    const protoCfg = loadConfig(configPath);
    const protoKeys = Object.keys(protoCfg.mcpServers);
    const protoEntry = protoCfg.mcpServers["__proto__"];
    check(
      'config keeps "__proto__" server entry as a normal own key (prototype-safe storage)',
      protoKeys.length === 1 && protoKeys[0] === "__proto__" && protoEntry !== undefined && "command" in protoEntry && protoEntry.command === "node",
      JSON.stringify(protoKeys)
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // --- connect 失败/超时:清理与可重试性 ---
  {
    const hungTransport = {
      start: () => new Promise<never>(() => {}),
      send: () => Promise.reject(new Error("not connected")),
      close: () => Promise.resolve(),
    };
    const hung = new Downstream("hung", { command: "node" }, hungTransport as unknown as Transport);
    let timeoutMsg = "";
    try {
      await hung.listTools(200);
    } catch (e) {
      timeoutMsg = errMsg(e);
    }
    check(
      "connect timeout surfaces error state after cleanup",
      timeoutMsg.includes("timed out") && hung.status === "error" && hung.lastError === timeoutMsg,
      `status=${hung.status}, err=${timeoutMsg}`
    );
    let retriedAndFailed = false;
    try {
      await hung.listTools(200);
    } catch {
      retriedAndFailed = true;
    }
    check("downstream stays retryable after failed connect (no deadlock, no leak loop)", retriedAndFailed);
    await hung.close();
  }

  // --- close 与 connecting 竞态:握手期间关闭,落定后必须一并回收 ---
  {
    const slowMcp = new McpServer({ name: "slow-echo-downstream", version: "0.1.0" });
    slowMcp.registerTool(
      "slow_add",
      {
        title: "Slow Add",
        description: "Add two numbers over a delayed handshake, verifying close-during-handshake behavior.",
        inputSchema: { a: z.number().describe("First addend"), b: z.number().describe("Second addend") },
      },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
    );
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await slowMcp.connect(serverTransport);
    // 延迟包装:仅 start 慢 250ms,其余全部转发 —— 模拟握手进行中的真实下游
    const delayed: Transport = {
      start: async () => {
        await sleep(250);
        await clientTransport.start();
      },
      send: (message) => clientTransport.send(message),
      close: () => clientTransport.close(),
      get onmessage() {
        return clientTransport.onmessage;
      },
      set onmessage(cb) {
        clientTransport.onmessage = cb;
      },
      get onclose() {
        return clientTransport.onclose;
      },
      set onclose(cb) {
        clientTransport.onclose = cb;
      },
      get onerror() {
        return clientTransport.onerror;
      },
      set onerror(cb) {
        clientTransport.onerror = cb;
      },
    };
    const slow = new Downstream("slow", { command: "noop" }, delayed);
    const connecting = slow.getClient(2000);
    await sleep(50);
    await slow.close();
    const first = await connecting;
    let secondError = "";
    try {
      await slow.getClient(1000);
    } catch (e) {
      secondError = errMsg(e);
    }
    // 修复前:close() 在握手期间是 no-op,握手完成的 client 被缓存,后续 getClient 会复用同一实例(不报错)
    check(
      "close() during handshake reclaims the settled client (next getClient reconnects)",
      !!first && secondError !== "",
      `secondError=${secondError}`
    );
  }

  // --- Windows .cmd 批处理下游:验证 cmd.exe 包装 ---
  if (process.platform === "win32") {
    const dir = mkdtempSync(join(tmpdir(), "mcp-router-smoke-cmd-"));
    const cmdPath = join(dir, "echo-server.cmd");
    writeFileSync(cmdPath, `@"${process.execPath}" --import tsx "${join(process.cwd(), "scripts", "echo-downstream.ts")}"\r\n`);
    const cmdDown = new Downstream("cmd-echo", { command: cmdPath });
    const cmdTools = await cmdDown.listTools(20000);
    check(
      "windows .cmd downstream spawns through cmd.exe wrapper",
      cmdTools.length === 2 && cmdDown.status === "connected",
      `status=${cmdDown.status}, tools=${cmdTools.map((t) => t.name).join(",")}`
    );
    await cmdDown.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
