import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-downstream", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided text, useful for verifying the router pipeline end to end.",
    inputSchema: { text: z.string().describe("Text to echo back") },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] })
);

server.registerTool(
  "add_numbers",
  {
    title: "Add numbers",
    description: "Add two numbers together and return the sum.",
    inputSchema: { a: z.number().describe("First addend"), b: z.number().describe("Second addend") },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] })
);

await server.connect(new StdioServerTransport());
console.error("[echo-downstream] ready");
