/**
 * E2E(HTTP 模式):真实进程链路验证 Streamable HTTP 对上游服务。
 * 覆盖: initialize / tools/list / search_tools / execute_tool / list_servers、
 * token 校验(401)、healthz、CORS 预检、GET /mcp 405、优雅退出。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { META_TOOL_NAMES } from "../src/server.js";

const ROOT = process.cwd();
const ROUTER = path.join(ROOT, "dist", "index.js");
// 测试自带临时配置,不依赖被 .gitignore 的本地 mcp-router.config.json(fresh clone 直接可跑)
const TMP_DIR = mkdtempSync(path.join(tmpdir(), "mcp-router-e2e-http-"));
const CONFIG = path.join(TMP_DIR, "mcp-router.config.json");
writeFileSync(
  CONFIG,
  JSON.stringify({
    mcpServers: {
      echo: { command: process.execPath, args: ["--import", "tsx", path.join(ROOT, "scripts", "echo-downstream.ts")] },
    },
  })
);
const TOKEN = "e2e-secret-token";
const PORT = 7801 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function httpJson(pathname: string, init?: RequestInit): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const res = await fetch(`${BASE}${pathname}`, init);
  const headers = Object.fromEntries(res.headers.entries());
  return { status: res.status, headers, body: await res.text() };
}

function bodyText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

async function expectFatal(args: string[], hint: string): Promise<boolean> {
  const child = spawn(process.execPath, [ROUTER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return code === 1 && err.includes(hint);
}

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    [ROUTER, "--config", CONFIG, "--transport", "http", "--port", String(PORT), "--auth-token", TOKEN],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  // 提前注册 exit 监听:启动失败时子进程可能在 finally 注册监听前就已退出,导致误报
  const childExit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  // stderr 同时转发与收集:收集用于验证"日志不回显校验令牌"
  let stderrBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[router] ${chunk}`);
    stderrBuf += chunk.toString();
  });

  try {
    // 等待 http server 就绪
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) { ready = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    check("router http server becomes ready on requested port", ready);
    if (!ready) return;

    // healthz 返回非敏感状态(不校验 token)
    const health = await httpJson("/healthz");
    const healthBody = JSON.parse(health.body) as { service?: string; auth?: boolean; version?: string };
    check(
      "healthz reports service/auth without token",
      health.status === 200 && healthBody.service === "mcp-router" && healthBody.auth === true && typeof healthBody.version === "string",
      health.body
    );

    // CORS 预检
    const preflight = await httpJson("/mcp", { method: "OPTIONS" });
    check(
      "OPTIONS preflight returns 204 with CORS headers",
      preflight.status === 204 && (preflight.headers["access-control-allow-origin"] ?? "") === "*" &&
        (preflight.headers["access-control-allow-headers"] ?? "").includes("Mcp-Session-Id"),
      JSON.stringify(preflight.headers)
    );

    // token 校验:无 token → 401
    const noToken = await httpJson("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    check("POST /mcp without token is rejected 401", noToken.status === 401 && (noToken.headers["www-authenticate"] ?? "") === "Bearer", `${noToken.status}`);

    // token 校验:错误 token → 401
    const badToken = await httpJson("/mcp?token=wrong", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    check("POST /mcp with wrong query token is rejected 401", badToken.status === 401, `${badToken.status}`);

    // token 校验:正确 Bearer → 通过鉴权(非 401)
    const okBearer = await httpJson("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bearer-probe", version: "0.0.0" } } }),
    });
    check("POST /mcp with correct Bearer token passes auth", okBearer.status !== 401, `${okBearer.status}`);

    // 日志脱敏:带 token 的请求 URL 不应把令牌回显进日志(检查 stderr 中不出现真实 token)
    const logProbe = await httpJson(`/mcp?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    check("correct query token passes auth", logProbe.status !== 401, `${logProbe.status}`);

    // 规范行为:stateless 下 GET /mcp → 405
    const getMcp = await httpJson("/mcp", { headers: { Authorization: `Bearer ${TOKEN}` } });
    check("GET /mcp returns 405 in stateless mode", getMcp.status === 405, `${getMcp.status}`);

    // ---- 正确 token 的完整 MCP 链路(真实 Streamable HTTP 客户端) ----
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { "X-MCP-Token": TOKEN } },
    });
    const client = new Client({ name: "e2e-http-client", version: "0.0.0" });
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    check("initialize over http returns mcp-router", serverInfo?.name === "mcp-router" && serverInfo?.version !== "", JSON.stringify(serverInfo));

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    check(
      "tools/list over http exposes exactly the meta-tools",
      JSON.stringify(names) === JSON.stringify([...META_TOOL_NAMES].sort()),
      names.join(", ")
    );

    // 等下游预热完成(echo server 经 npx tsx 启动)
    const warmDeadline = Date.now() + 60000;
    let warmed = false;
    while (Date.now() < warmDeadline) {
      const browse = await client.callTool({ name: "search_tools", arguments: { query: "" } });
      const text = bodyText(browse);
      if (text.includes("echo::echo")) { warmed = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check("router warms up downstream over http transport", warmed);

    const search = await client.callTool({ name: "search_tools", arguments: { query: "add two numbers" } });
    const searchText = bodyText(search);
    check("search finds add_numbers over http", searchText.includes("echo::add_numbers"), searchText);

    const exec = await client.callTool({ name: "execute_tool", arguments: { id: "echo::add_numbers", arguments: { a: 20, b: 22 } } });
    const execText = bodyText(exec);
    check("execute round-trips over http to spawned downstream", execText.includes("42") && exec.isError !== true, execText);

    const servers = await client.callTool({ name: "list_servers", arguments: {} });
    const serversText = bodyText(servers);
    check("list_servers over http reports connected downstream", serversText.includes("echo") && serversText.includes("connected"), serversText);

    // 安全配置必须 fail-fast,而不是静默关闭鉴权或暴露到局域网
    check(
      "--auth-token with no value fails fast",
      await expectFatal(["--config", CONFIG, "--transport", "http", "--auth-token"], "需要一个非空的值")
    );
    check(
      "--host 0.0.0.0 without token fails fast",
      await expectFatal(["--config", CONFIG, "--transport", "http", "--host", "0.0.0.0"], "必须启用鉴权")
    );

    await client.close();
  } finally {
    // 优雅退出:SIGTERM(Windows 下 kill 不可靠,统一 taskkill 兜底前先尝试消息)
    if (process.platform === "win32") {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"]);
    } else {
      child.kill("SIGTERM");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      childExit,
      new Promise<number | null>((resolve) => {
        timer = setTimeout(() => resolve(null), 15000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    check("router http process tree is terminated", exit !== null, `exit=${exit}`);

    // 进程树死后端口必须释放(无残留监听)
    await new Promise((r) => setTimeout(r, 500));
    let portReleased = false;
    try {
      await fetch(`${BASE}/healthz`);
    } catch {
      portReleased = true;
    }
    check("listening port is released after process termination", portReleased);

    // 日志脱敏:stderr 输出中不应出现 URL 查询串里的真实令牌
    check("router logs never echo the auth token from query strings", !stderrBuf.includes(`token=${TOKEN}`));
    rmSync(TMP_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

const guard = setTimeout(() => {
  console.error("e2e-http test timed out");
  process.exit(2);
}, 180_000);
guard.unref();

main().catch((e) => {
  console.error("e2e-http test crashed:", e);
  process.exit(1);
});
