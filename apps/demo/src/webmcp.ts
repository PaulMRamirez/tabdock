// The slice of the WebMCP API (document.modelContext) that the demo uses.
// Declared locally rather than imported so the demo depends only on the
// standard shape, which native Chrome and the MCP-B polyfill both provide.
// Source: webmachinelearning.github.io/webmcp and @mcp-b/webmcp-types 5.1.0,
// checked 2026-10-02 (see docs/notes/verified.md).

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  execute: (input: unknown, options?: ToolExecuteOptions) => Promise<unknown>;
}

export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextLike;
  }
}
