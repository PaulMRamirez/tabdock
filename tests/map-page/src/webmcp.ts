// The slice of WebMCP (document.modelContext) this page uses, declared here so
// the page depends only on the standard shape, which native Chrome and the
// MCP-B polyfill both provide. The tools are the sim page's map tools, whose
// shape is WebMCP's registerTool argument.

import type { MapToolDefinition } from '@tabdock/sim-page/map';

export interface ModelContextLike extends EventTarget {
  registerTool(tool: MapToolDefinition, options?: { signal?: AbortSignal }): Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextLike;
  }
}
