# @tabdock/sim-page

A Node stand-in for a browser page, so relay tests run without a browser. `FakeModelContext` (`src/fake-model-context.ts`) reproduces the WebMCP runtimes measured in `docs/notes/baseline.md`: `RUNTIME_PROFILES` holds `polyfill-5.1`, `chrome-154` and `chrome-156`, which every loop in the suite has run since M2, and `ALL_RUNTIME_PROFILES` adds `mcpb-6`, MCP-B's polyfill 6.0.0, which takes what Chrome 156 takes but serializes every result as JSON and gives every handler error one opaque text (ADRs 0039 and 0047), each checked against the raw files by its tests. `startSimPage()` (`src/sim-page.ts`) runs the real adapter core against it over a `ws` socket that sends an `Origin` header.

```ts
import { startSimPage } from '@tabdock/sim-page';

const sim = await startSimPage({
  relayUrl: 'ws://127.0.0.1:8787/page',
  profile: 'polyfill-5.1',
  operator: { askAttach: () => 'driver', askConfirm: () => true },
});
const { pairing } = await sim.waitFor((state) => state.link === 'linked');
// ... pair a client with pairing.code, call tools ...
sim.setRole('bob', 'observer'); // the operator's roster controls and pause switch
sim.revoke('*');
sim.pause(true); // every new call gets page_busy until sim.pause(false)
console.log(sim.activity); // the last 50 calls, newest first
await sim.reload(); // a browser reload: same storage, so the page resumes (and stays paused)
await sim.reload({ awayMs: 5000 }); // the same, with the tab gone for 5 s first
await sim.navigate('/settings'); // another page of the origin in the tab: its own session (ADR 0011)
await sim.close();
```

From M4 `sim.invite({ label, role, lifetime, uses })` mints an invite for real with Node's WebCrypto against a relay that offers invites (ADR 0017), `sim.cancelInvite(id)` closes one and `sim.revoke(userId, { closeInvite })` revokes someone an invite let in; the page keeps its invite records across `sim.reload()` while the relay resumes the session, honours a Can watch redemption without asking, and puts a Can control one to `operator.askAttach`, whose request names the invite. `crypto` swaps the WebCrypto, so a test can play a page outside a secure context.

From M5 `policy: { confirmVia: 'client' }` makes the sim page one that lets its member drivers confirm consequential calls in their own clients (ADR 0026): its hello says so, its tools frame marks each tool the page counts as consequential (`wipe`, and on `polyfill-5.1`, which drops the hint, `set_value` too) whatever the policy, and an invoke carrying `confirmation` runs without asking only for a member driver the operator approved directly, with `confirmedBy: 'client'` in `sim.activity`. Every other call prompts as before, and `sim.prompts` lists each consequential prompt the page raised, across reloads, so a test can see whether the page asked.

The default tools, from `src/default-tools.ts`, are `get_value` (read-only), `set_value` (mutating), `wipe` (consequential), and the read-only helpers `echo`, `slow` and `fail`. Without an operator, prompts wait for `sim.dock`, and silence until the deadline denies.

From M6 the sim page runs every handle member the real adapter has, so `sim.publishState()`, `sim.startSession()` and `sim.agentToken()` play the operator's widget, and `stateFrom` publishes the store's state after each call that succeeds (ADRs 0040, 0043 and 0044); `clock` runs the page's clock apart from the relay's, and the `mcpb-6` runtime profile serializes results as MCP-B 6.0.0 does. `createImageTools()` (`src/image-tools.ts`) adds opt-in image tools, `capture`, `capture_string` and `image_raw`, whose PNGs `pngImage()` draws at an exact size, so the six default tools many tests count stay as they are (ADR 0039).

Beside the root entry, `.` (`src/index.ts`), the `./map` entry, `@tabdock/sim-page/map` (`src/map/index.ts`), is the map and globe profile (ADR 0038), safe to bundle for a browser since nothing in `src/map/` imports `ws` or `node:`: `profile.ts` holds the tool names, groups, annotations and zod 4.6.5 schemas with `MAP_PAGE_POLICY`, `geometry.ts` the projection math the world and the canvas share, `world.ts` the in-memory `MapWorld`, `tools.ts` the handlers over it, and `moon.ts` the Moon fixture, all of which the canvas page in `tests/map-page` and the CI check share. `startMapSimPage()` (`src/map-sim.ts`) runs that profile in Node through the real adapter core, with `capture_view` returning an image when a test passes a `capture`, and the world surviving `reload()` as a page's server-side state would. [Map and globe pages](../../docs/guide/16-map-pages.md) documents the profile.
