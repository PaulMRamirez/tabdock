# @tabdock/map-page

A map and globe page drawn on a plain canvas with no map library, which registers the map profile's sixteen tools (guide page 16, `docs/guide/16-map-pages.md`) through WebMCP and links to a Tabdock relay. It is the browser half of ADR 0038's worked example: the same `MapWorld` and tools that `@tabdock/sim-page/map` runs in Node, drawn by `src/render.ts`, on the MCP-B polyfill at exactly 5.1.0 where the browser has no native WebMCP. It is private and never published.

Try it by hand from a clone, with a relay running (`pnpm relay` in another terminal):

```sh
pnpm dev:map
```

Open the address it prints (port 5174 unless `MAP_PAGE_PORT` or `--port` says), check the relay URL in the Connect form, and press Connect. The widget shows a pairing code; pair a client with `pair_page`, approve it in the widget, and drive the Moon with `get_view`, `go_to_stop` and the rest. Drag to pan and scroll to zoom; the call strip names each tool and how it ended, never its arguments.

The page dials a relay only on a trusted click on Connect. It reads nothing from its URL, so no link can make it dial, and a script's click or `form.requestSubmit()` does nothing. Tests and the CI check connect it with `window.__tabdockMapPage.connect(relayUrl, policy?)` instead, which exists because the page is never published; it takes the same URL checks, links once, and hands out no handle, so a test still approves through the widget as an operator would. Its policy is `MAP_PAGE_POLICY` with `capture_view` as an image tool; `connect()` may raise it for a test that needs proposals or more drivers.

`scripts/server.ts` builds the page with esbuild in memory and serves it on 127.0.0.1 only, answering 421 to any other Host so a rebound name cannot read it, under a policy that admits its own script and its one inline style. Specs import `startMapPageServer()` from `@tabdock/map-page/server` to serve it on a free port. `test/package.test.ts` holds its dependencies to the polyfill, the adapter and the sim page.
