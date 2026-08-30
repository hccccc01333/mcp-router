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
    let count = 0;
    for (const entry of this.byId.values()) {
      if (entry.server === server) count++;
    }
    return count;
  }

  replaceServer(server: string, tools: Tool[]): void {
    for (const [id, entry] of [...this.byId.entries()]) {
      if (entry.server === server) this.byId.delete(id);
    }
    for (const tool of tools) {
      this.byId.set(toolId(server, tool.name), { id: toolId(server, tool.name), server, tool });
    }
  }
}
