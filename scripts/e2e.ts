import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { META_TOOL_NAMES } from "../src/server.js";

const ROOT = process.cwd();
const ROUTER = path.join(ROOT, "dist", "index.js");
const CONFIG = path.join(ROOT, "mcp-router.config.json");

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function bodyOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? [])
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("\n");
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, [ROUTER, "--config", CONFIG], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcResponse;
    try {
      msg = JSON.parse(trimmed) as RpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[router] ${chunk}`));

  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

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

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-client", version: "0.0.0" },
    }) as { serverInfo?: { name?: string } };
    check("initialize handshake returns mcp-router", init.serverInfo?.name === "mcp-router", JSON.stringify(init));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await request("tools/list") as { tools: Array<{ name: string }> };
    const names = listed.tools.map((t) => t.name).sort();
    check(
      "tools/list over real stdio exposes exactly the meta-tools",
      JSON.stringify(names) === JSON.stringify([...META_TOOL_NAMES].sort()),
      names.join(", ")
    );

    const deadline = Date.now() + 45000;
    let warmed = false;
    while (Date.now() < deadline) {
      const browse = await request("tools/call", { name: "search_tools", arguments: { query: "" } });
      if (bodyOf(browse).includes("echo::echo")) {
        warmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check("router warms up npx-spawned downstream on win32", warmed);

    const search = await request("tools/call", { name: "search_tools", arguments: { query: "add two numbers" } });
    check("search finds add_numbers through spawned chain", bodyOf(search).includes("echo::add_numbers"), bodyOf(search));

    const exec = await request("tools/call", {
      name: "execute_tool",
      arguments: { id: "echo::add_numbers", arguments: { a: 20, b: 22 } },
    });
    check("execute round-trips to child process", bodyOf(exec).includes("42") && !(exec as { isError?: boolean }).isError, bodyOf(exec));

    const servers = await request("tools/call", { name: "list_servers", arguments: {} });
    check("list_servers reports connected spawned server", bodyOf(servers).includes("connected") && bodyOf(servers).includes("2 tools"), bodyOf(servers));

    if (process.env.E2E_WAIT_ALL === "1") {
      const deadlineAll = Date.now() + 90000;
      let serversBody = "";
      let catalogCount = 0;
      while (Date.now() < deadlineAll) {
        serversBody = bodyOf(await request("tools/call", { name: "list_servers", arguments: {} }));
        const browse = bodyOf(await request("tools/call", { name: "search_tools", arguments: { query: "" } }));
        const match = browse.match(/Tool catalog: (\d+)/);
        catalogCount = match ? Number(match[1]) : 0;
        if (/everything-[0-9] \| stdio \| connected/.test(serversBody) && catalogCount > 5) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      check(
        "third-party downstream aggregated into shared catalog",
        /everything-[0-9] \| stdio \| connected/.test(serversBody) && catalogCount > 5,
        `catalog=${catalogCount}\n${serversBody}`
      );

      const sampled = await request("tools/call", { name: "search_tools", arguments: { query: "random" } });
      console.log(`sample search result:\n${bodyOf(sampled)}`);
    }
  } finally {
    if (process.platform === "win32") {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      if (child.pid) spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"]);
    } else {
      child.kill("SIGTERM");
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

const guard = setTimeout(() => {
  console.error("e2e test timed out");
  process.exit(2);
}, process.env.E2E_WAIT_ALL === "1" ? 240_000 : 120_000);
guard.unref();

main().catch((e) => {
  console.error("e2e test crashed:", e);
  process.exit(1);
});
