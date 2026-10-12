# @tabdock/map-page

A map and globe page drawn on a plain canvas with no map library, which registers sixteen tools through WebMCP and links to a Tabdock relay: the map profile's fourteen (`MAP_PROFILE_TOOLS` in `packages/sim-page/src/map/profile.ts`, documented in [Map and globe pages](../../docs/guide/16-map-pages.md)) and the worked example's own `edit_stop` and `reset_edits`, the one consequential tool. It is the browser half of ADR 0038's worked example: the same `MapWorld` and tools that `@tabdock/sim-page/map` runs in Node, registered by `src/main.ts` through the slice of WebMCP `src/webmcp.ts` declares and drawn by `src/draw.ts`, on the MCP-B polyfill at exactly 5.1.0 where the browser has no native WebMCP. It is private and never published.

Try it by hand from a clone, with a relay running (`pnpm relay` in another terminal):

```sh
pnpm dev:map
```

Open the address it prints (port 5174 unless `MAP_PAGE_PORT` or `--port` says), check the relay URL in the Connect form, and press Connect. The widget shows a pairing code; pair a client with `pair_page`, approve it in the widget, and drive the Moon with `get_view`, `go_to_stop` and the rest. Drag to pan and scroll to zoom, each gesture one write to the world (`src/gestures.ts`); the call strip names each tool and how it ended, never its arguments.

The page dials a relay only on a trusted click on Connect. It reads nothing from its URL, so no link can make it dial, and a script's click or `form.requestSubmit()` does nothing. Tests and the CI check connect it with `window.__tabdockMapPage.connect(relayUrl, policy?)` instead, which exists because the page is never published; it takes the same URL checks, links once, and hands out no handle, so a test still approves through the widget as an operator would. Its policy is `MAP_PAGE_POLICY` with `capture_view` as an image tool; `connect()` may raise it for a test that needs proposals or more drivers. `capture_view` answers with a PNG or JPEG of the world drawn again onto a canvas of its own, never the tab, fitted under the relay's cap (`src/capture.ts`), and the page publishes its state, the view, clock, walkthrough stop and observation, on each discrete change, which clients read with `get_page_state` and follow with `wait_for_page_state` (ADRs 0039 and 0040).

`scripts/server.ts` builds the page with esbuild in memory and serves it on 127.0.0.1 only, taking a Host of `127.0.0.1`, `localhost` or `[::1]` with its own port and answering 421 to any other, so a name rebound to 127.0.0.1 cannot read it, under a policy that admits its own script and its one inline style. Specs and `pnpm demo:m6` import `startMapPageServer()` from the package's one export, `./server` (`@tabdock/map-page/server`), to serve it on a free port. `test/package.test.ts` holds its dependencies to the polyfill, the adapter and the sim page.
