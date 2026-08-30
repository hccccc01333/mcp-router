import type { ToolEntry } from "./registry.js";

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0);
}

export function scoreEntry(entry: ToolEntry, normalizedQuery: string, tokens: string[]): number {
  const name = entry.tool.name.toLowerCase();
  const server = entry.server.toLowerCase();
  const desc = (entry.tool.description ?? "").toLowerCase();
  const haystack = `${server} ${name} ${desc}`;
  let score = 0;
  if (normalizedQuery.length >= 2 && haystack.includes(normalizedQuery)) score += 6;
  for (const token of tokens) {
    if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token)) continue;
    if (name === token) score += 5;
    else if (name.startsWith(token)) score += 3;
    else if (name.includes(token)) score += 2;
    if (server.includes(token)) score += 1.5;
    if (desc.includes(token)) score += 1;
  }
  return score;
}

export function searchEntries(entries: ToolEntry[], query: string): ToolEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  const tokens = tokenize(normalized);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, normalized, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map((r) => r.entry);
}

export function summarizeParams(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "";
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties ? Object.keys(s.properties) : [];
  if (props.length === 0) return "";
  const required = Array.isArray(s.required)
    ? s.required.filter((v): v is string => typeof v === "string")
    : [];
  return props.map((p) => `${p}${required.includes(p) ? "*" : ""}`).join(", ");
}

export function formatCard(entry: ToolEntry): string {
  const desc = (entry.tool.description ?? "").replace(/\s+/g, " ").slice(0, 120);
  const params = summarizeParams(entry.tool.inputSchema);
  return `- [${entry.id}] ${entry.server}/${entry.tool.name}${params ? ` (${params})` : ""}\n  ${desc}`;
}
