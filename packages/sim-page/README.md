# @tabdock/sim-page

A Node stand-in for a browser page, so relay tests run without a browser. `FakeModelContext` reproduces the WebMCP runtimes measured in `docs/notes/baseline.md` (profiles `polyfill-5.1`, `chrome-154` and `chrome-156`, checked against the raw files by its tests), and `startSimPage()` runs the real adapter core against it over a `ws` socket that sends an `Origin` header.

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
await sim.close();
```

The default tools are `get_value` (read-only), `set_value` (mutating), `wipe` (consequential), and the read-only helpers `echo`, `slow` and `fail`. Without an operator, prompts wait for `sim.dock`, and silence until the deadline denies.
