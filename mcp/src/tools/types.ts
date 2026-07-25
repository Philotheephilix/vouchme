// @aval/mcp — src/tools/types.ts
//
// The shape every file in src/tools/*.ts exports, so src/index.ts can
// register all 17 tools identically instead of hand-wiring each one.

import type { z } from "zod";
import type { GraphClient } from "../client.js";
import type { ToolResult } from "../response.js";

export interface ToolContext {
  client: GraphClient;
  /**
   * The address this MCP server acts on behalf of — the human or platform
   * running it. Used by tools with effects (aval_report, aval_request_score)
   * where docs/06-mcp-skills.md's tool signature doesn't take a "reporter"
   * parameter explicitly; it is the server's own operator identity, read
   * from AVAL_OPERATOR_ADDRESS (see mcp/README.md).
   */
  operatorAddress?: string | undefined;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: ToolContext) => Promise<ToolResult>;
}
