import { readFileSync } from "node:fs";

export const ROUTER_VERSION = "0.1.0";

export interface StdioDownstream {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpDownstream {
  url: string;
  headers?: Record<string, string>;
}

export type DownstreamSpec = StdioDownstream | HttpDownstream;

export interface RouterConfig {
  mcpServers: Record<string, DownstreamSpec>;
  timeouts: { connectMs: number; callMs: number };
  maxResultChars: number;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, name: string) => process.env[name] ?? raw);
}

function expandSpec(spec: DownstreamSpec): DownstreamSpec {
  if ("command" in spec) {
    return {
      ...spec,
      command: expandEnvVars(spec.command),
      args: spec.args?.map(expandEnvVars),
      env: spec.env
        ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, expandEnvVars(v)]))
        : undefined,
      cwd: spec.cwd ? expandEnvVars(spec.cwd) : undefined,
    };
  }
  return {
    ...spec,
    url: expandEnvVars(spec.url),
    headers: spec.headers
      ? Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, expandEnvVars(v)]))
      : undefined,
  };
}

function stringMap(name: string, key: string, raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`mcpServers.${name}.${key} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function parseSpec(name: string, raw: unknown): DownstreamSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`mcpServers.${name} must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.url === "string") {
    const spec: HttpDownstream = { url: s.url };
    const headers = stringMap(name, "headers", s.headers);
    if (headers) spec.headers = headers;
    return spec;
  }
  if (typeof s.command === "string") {
    const spec: StdioDownstream = { command: s.command };
    if (s.args !== undefined) {
      if (!Array.isArray(s.args)) throw new Error(`mcpServers.${name}.args must be an array`);
      spec.args = s.args.map(String);
    }
    const env = stringMap(name, "env", s.env);
    if (env) spec.env = env;
    if (s.cwd !== undefined) {
      if (typeof s.cwd !== "string") throw new Error(`mcpServers.${name}.cwd must be a string`);
      spec.cwd = s.cwd;
    }
    return spec;
  }
  throw new Error(`mcpServers.${name} must define either "command" (stdio) or "url" (http)`);
}

export function resolveConfigPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MCP_ROUTER_CONFIG) return process.env.MCP_ROUTER_CONFIG;
  return "mcp-router.config.json";
}

export function loadConfig(explicitPath?: string): RouterConfig {
  const path = resolveConfigPath(explicitPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`failed to read router config at ${path}: ${errMsg(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`router config ${path} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const serversRaw = root.mcpServers ?? root.servers;
  if (typeof serversRaw !== "object" || serversRaw === null || Array.isArray(serversRaw)) {
    throw new Error(`router config ${path} must contain an "mcpServers" object`);
  }
  const mcpServers: Record<string, DownstreamSpec> = {};
  for (const [name, raw] of Object.entries(serversRaw as Record<string, unknown>)) {
    mcpServers[name] = expandSpec(parseSpec(name, raw));
  }
  if (Object.keys(mcpServers).length === 0) {
    console.error(`[mcp-router] warning: no downstream servers configured in ${path}`);
  }
  const timeouts = { connectMs: 15000, callMs: 90000 };
  if (typeof root.timeouts === "object" && root.timeouts !== null) {
    const t = root.timeouts as Record<string, unknown>;
    if (typeof t.connectMs === "number" && t.connectMs > 0) timeouts.connectMs = t.connectMs;
    if (typeof t.callMs === "number" && t.callMs > 0) timeouts.callMs = t.callMs;
  }
  let maxResultChars = 24000;
  if (typeof root.maxResultChars === "number" && root.maxResultChars >= 1000) {
    maxResultChars = root.maxResultChars;
  }
  return { mcpServers, timeouts, maxResultChars };
}