# @tabdock/demo

A small canvas board whose state is easy to see, with six WebMCP tools: `get_view` and `list_items` read; `add_item`, `move_view` and `highlight_item` change the board; `clear_board` is consequential. People can pan by dragging and zoom with the wheel; every tool call is drawn at once and listed in the strip under the board.

`pnpm dev` (from the repo root) serves it at `http://127.0.0.1:5173/` with live rebuilds; set `DEMO_PORT` in `.env` to move it. Adding `?mcpb` to the URL loads MCP-B's local relay embed, which the M0 baseline uses; `?mcpb=9444` also picks the relay port.

Files: `src/board.ts` holds the state, `src/tools.ts` defines the tools with zod schemas that double as their JSON Schemas, `src/render.ts` draws, `src/main.ts` installs the polyfill and registers the tools, and `scripts/server.ts` builds and serves with esbuild.
