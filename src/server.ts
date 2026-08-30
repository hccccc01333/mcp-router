import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ROUTER_VERSION, errMsg, type RouterConfig } from "./config.js";
import { Downstream } from "./downstream.js";
import { ToolRegistry } from "./registry.js";
import { formatCard, searchEntries } from "./search.js";
import type { UsageStats } from "./stats.js";

export const META_TOOL_NAMES = ["search_tools", "get_tool_schema", "execute_tool", "list_servers", "tool_stats"] as const;

export interface RouterContext {
  config: RouterConfig;
  downstreams: Map<string, Downstream>;
  registry: ToolRegistry;
  warmup: Promise<void>;
  stats?: UsageStats;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function serializeToolResult(result: CallToolResult, maxChars: number): string {
  let body: string;
  if (result.structuredContent !== undefined) {
    body = JSON.stringify(result.structuredContent, null, 2);
  } else {
    const parts = (result.content ?? []).map((block) =>
      block.type === "text" ? block.text : `[${block.type}] ${JSON.stringify(block)}`
    );
    body = parts.join("\n");
  }
  if (!body) body = "(tool returned no content)";
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n…[truncated by mcp-router: ${body.length - maxChars} chars omitted]`;
  }
  return body;
}

function suggestIds(registry: ToolRegistry, id: string): string[] {
  return searchEntries(registry.all(), id.replace(/::/g, " "))
    .slice(0, 3)
    .map((e) => e.id);
}

export function createRouterServer(ctx: RouterContext): McpServer {
  const server = new McpServer({ name: "mcp-router", version: ROUTER_VERSION });

  server.registerTool(
    "search_tools",
    {
      title: "Search aggregated MCP tools",
      description:
        "Search the unified catalog of ALL downstream MCP servers managed by this router (potentially hundreds of tools). ALWAYS start here before using any capability. Returns compact tool cards whose IDs feed get_tool_schema and execute_tool.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Keywords describing the needed capability, e.g. 'github pull request', 'browser screenshot', '执行 SQL'. Use an empty string to browse a sample of the catalog."
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Max results, default 8."),
      },
    },
    async ({ query, limit }) => {
      await Promise.race([ctx.warmup.catch(() => {}), sleep(4000)]);
      const max = limit ?? 8;
      const all = ctx.registry.all();
      const q = query.trim();
      if (!q) {
        const sample = all.slice(0, max).map(formatCard).join("\n");
        return text(
          `Tool catalog: ${all.length} tools from ${ctx.downstreams.size} servers. Showing first ${Math.min(max, all.length)}; use keyword search for specific capabilities.\n\n${sample || "(no tools registered yet)"}`
        );
      }
      const hits = searchEntries(all, q).slice(0, max);
      ctx.stats?.recordSearch(q, hits.map((e) => e.id));
      if (hits.length === 0) {
        return text(`No tools matched "${q}". Try broader keywords, or call list_servers to see connected servers.`);
      }
      return text(`Found ${hits.length} tool(s) for "${q}". Next: get_tool_schema(id), then execute_tool(id, arguments).\n\n${hits.map(formatCard).join("\n")}`);
    }
  );

  server.registerTool(
    "get_tool_schema",
    {
      title: "Get full schema of an aggregated tool",
      description:
        "Return the full input schema of one tool discovered via search_tools so you can build correct arguments for execute_tool.",
      inputSchema: {
        id: z.string().describe("Tool ID exactly as returned by search_tools, e.g. github::create_issue."),
      },
    },
    async ({ id }) => {
      await Promise.race([ctx.warmup.catch(() => {}), sleep(4000)]);
      const entry = ctx.registry.get(id);
      if (!entry) {
        const suggestions = suggestIds(ctx.registry, id);
        return text(
          `Unknown tool id "${id}".${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""} Run search_tools first.`,
          true
        );
      }
      ctx.stats?.recordSchema(id);
      return text(
        JSON.stringify(
          { id: entry.id, server: entry.server, name: entry.tool.name, description: entry.tool.description, inputSchema: entry.tool.inputSchema },
          null,
          2
        )
      );
    }
  );

  server.registerTool(
    "execute_tool",
    {
      title: "Execute an aggregated tool on its downstream MCP server",
      description:
        "Run a tool discovered via search_tools, routing the call to the right downstream server. Pass arguments matching the schema from get_tool_schema.",
      inputSchema: {
        id: z.string().describe("Tool ID from search_results."),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments matching the tool's inputSchema."),
      },
    },
    async ({ id, arguments: args }) => {
      const entry = ctx.registry.get(id);
      if (!entry) {
        const suggestions = suggestIds(ctx.registry, id);
        return text(
          `Unknown tool id "${id}".${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""} Run search_tools first.`,
          true
        );
      }
      const down = ctx.downstreams.get(entry.server);
      if (!down) {
        ctx.stats?.recordCall(id, false);
        return text(`Downstream server "${entry.server}" is not configured.`, true);
      }
      try {
        const result = await down.callTool(ctx.config.timeouts.callMs, entry.tool.name, args);
        ctx.stats?.recordCall(id, result.isError !== true);
        return text(serializeToolResult(result, ctx.config.maxResultChars), result.isError === true);
      } catch (e) {
        ctx.stats?.recordCall(id, false);
        return text(`execute_tool failed for ${id}: ${errMsg(e)}`, true);
      }
    }
  );

  server.registerTool("list_servers", {
    title: "List managed downstream MCP servers",
    description: "Show every downstream server behind this router: transport, connection status and registered tool count.",
    inputSchema: {},
  }, async () => {
    await Promise.race([ctx.warmup.catch(() => {}), sleep(4000)]);
    const lines: string[] = [];
    for (const down of ctx.downstreams.values()) {
      const status = down.status === "error" ? `error (${down.lastError ?? "unknown"})` : down.status;
      lines.push(`${down.name} | ${down.kind} | ${status} | ${ctx.registry.countByServer(down.name)} tools | ${down.target}`);
    }
    return text(
      `Managed servers: ${ctx.downstreams.size}, registered tools: ${ctx.registry.size}\nUse search_tools to discover capabilities.\n\n${lines.join("\n") || "(none configured)"}`
    );
  });

  server.registerTool("tool_stats", {
    title: "View aggregated tool usage statistics",
    description:
      "Show which downstream tools are actually being used: top-ranked tools by usage, error counts, and recent search queries. Useful for deciding which tools matter and for future automatic tool selection. Read-only; does not affect any tool.",
    inputSchema: {},
  }, async () => {
    if (!ctx.stats) return text("Usage statistics are disabled in this router instance.", true);
    const snap = ctx.stats.snapshot();
    const t = snap.totals;
    const rows = snap.topTools
      .map(
        (r) =>
          `${r.id} | score ${r.score} | calls ${r.calls}${r.errors ? ` (${r.errors} err)` : ""} | search ${r.searchHits} | schema ${r.schemaViews}`
      )
      .join("\n");
    const searches = snap.recentSearches
      .slice(0, 10)
      .map((s) => `"${s.query}" -> ${s.hits.length} hit(s)`)
      .join("\n");
    return text(
      `Totals: ${t.searches} searches, ${t.schemas} schema views, ${t.calls} tool calls, ${t.errors} errors.\n\nTop tools (by usage score):\n${rows || "(no activity yet)"}${searches ? `\n\nRecent searches:\n${searches}` : ""}`
    );
  });

  return server;
}
