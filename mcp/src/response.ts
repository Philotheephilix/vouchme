// @aval/mcp — src/response.ts
//
// Every tool response is a JSON object matching docs/06-mcp-skills.md's
// documented shape *exactly*, carrying `subgraphDeployment` and
// `computedAtBlock` (design rule, docs/06 §3: "Claims must be
// re-derivable"). Tools return that object as the text of a single MCP
// content block — the standard way structured tool output travels over
// stdio — via `jsonResult()` below, so every tool file does this the same
// way instead of re-inventing the envelope.

export interface Meta {
  subgraphDeployment: string;
  computedAtBlock: number;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

/** Wraps a JSON-serializable object as a tool result's text content. */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Plain prose result — used only by aval_explain, whose documented return type is `string`. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A *named* error, per docs/06 §3 ("Errors name the constraint
 * (NoSlots, RateLimited) — Retriable vs terminal must be distinguishable")
 * and §2.12b's precondition table (InsufficientTier, NoConnection, ...).
 * Serialized the same way a normal result is, with `isError: true` so MCP
 * clients surface it as a tool failure rather than a successful answer.
 */
export class AvalToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AvalToolError";
  }
}

export function errorResult(err: AvalToolError): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: err.code, message: err.message, ...err.extra }, null, 2),
      },
    ],
    isError: true,
  };
}
