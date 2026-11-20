import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolEntry {
  id: string;
  server: string;
  tool: Tool;
}

export function toolId(server: string, toolName: string): string {
  return `${server}::${toolName}`;
}

export class ToolRegistry {
  private byId = new Map<string, ToolEntry>();
  // 每个下游的工具计数,增量维护,避免 list_servers 时 O(servers × tools) 全目录扫描
  private counts = new Map<string, number>();

  get size(): number {
    return this.byId.size;
  }

  all(): ToolEntry[] {
    return [...this.byId.values()];
  }

  get(id: string): ToolEntry | undefined {
    return this.byId.get(id);
  }

  countByServer(server: string): number {
    return this.counts.get(server) ?? 0;
  }

  replaceServer(server: string, tools: Tool[]): void {
    for (const [id, entry] of [...this.byId.entries()]) {
      if (entry.server === server) {
        this.byId.delete(id);
        const left = (this.counts.get(server) ?? 1) - 1;
        if (left > 0) this.counts.set(server, left);
        else this.counts.delete(server);
      }
    }
    for (const tool of tools) {
      this.byId.set(toolId(server, tool.name), { id: toolId(server, tool.name), server, tool });
    }
    if (tools.length > 0) this.counts.set(server, (this.counts.get(server) ?? 0) + tools.length);
  }
}
