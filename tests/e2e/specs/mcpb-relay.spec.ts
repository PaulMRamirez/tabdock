import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { DEMO_TOOL_NAMES, startBaseline, type Baseline } from '../src/harness.ts';

// A0.2, scripted: an MCP client lists and calls the demo page's tools through
// MCP-B's local relay. The manual Claude Code run is in docs/checklists/M0.md.

let baseline: Baseline;
test.beforeAll(async () => {
  baseline = await startBaseline();
});
test.afterAll(async () => {
  await baseline.close();
});

function structured(result: unknown): unknown {
  return (result as { structuredContent?: unknown }).structuredContent;
}

test('lists the six demo tools beside the relay management tools', async () => {
  const { tools } = await baseline.client.listTools(undefined, { cacheMode: 'refresh' });
  const names = tools.map((t) => t.name);
  for (const name of DEMO_TOOL_NAMES) expect(names).toContain(name);
  expect(names).toContain('webmcp_list_sources');
});

test('calls every demo tool and sees each change land', async () => {
  const { client } = baseline;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  // Far from the three seeded items, so the zoomed view below contains only this one.
  const added = await call('add_item', { label: 'Relayed', x: 3000, y: 3000, color: 'red' });
  expect(added.isError).toBe(false);
  expect(structured(added)).toMatchObject({ item: { id: 'item-4', label: 'Relayed' } });

  expect(structured(await call('move_view', { x: 3000, y: 3000, zoom: 2 }))).toEqual({
    view: { x: 3000, y: 3000, zoom: 2 },
  });
  expect(structured(await call('highlight_item', { id: 'item-4' }))).toMatchObject({
    item: { highlighted: true },
  });
  expect(structured(await call('get_view'))).toMatchObject({ zoom: 2, visibleItemIds: ['item-4'] });
  expect(structured(await call('list_items'))).toMatchObject({ total: 4 });
  expect(structured(await call('clear_board'))).toEqual({ removed: 4 });
  await expect(baseline.page.locator('[data-role="view"]')).toHaveText(/0 items/);
});

test('a page handler error returns as an MCP tool error', async () => {
  const result = await baseline.client.callTool({
    name: 'highlight_item',
    arguments: { id: 'item-999' },
  });
  expect(result.isError).toBe(true);
});

test('the relay ignores a page whose origin is not on its widget allowlist', async () => {
  // localhost and 127.0.0.1 are different origins; the relay only allows the latter.
  const other = await baseline.browser.newPage();
  const url = new URL(baseline.demo.url);
  url.hostname = 'localhost';
  url.search = `?mcpb=${baseline.relayPort}`;
  await other.goto(url.href);
  await other.waitForSelector('html[data-tools="ready"]');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const result = await baseline.client.callTool({ name: 'webmcp_list_sources', arguments: {} });
  const sources = (structured(result) as { sources: { origin: string }[] }).sources;
  expect(sources.map((s) => s.origin)).toEqual([url.origin.replace('localhost', '127.0.0.1')]);
  await other.close();
});

test('the demo server forbids framing by other origins', async () => {
  // Deterministic half of the check below: the headers that stop the injection.
  const response = await fetch(new URL('vendor/webmcp-local-relay/widget.html', baseline.demo.url));
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
});

test('a page on another origin cannot frame the vendored widget to inject tools', async () => {
  // The attack the frame-ancestors header stops: a foreign page frames the demo
  // origin's copy of widget.html, which would then connect with the allowed Origin
  // and relay whatever tools the foreign parent claims to have.
  const attackerPage = `<!doctype html><body><script>
    const p = new URLSearchParams(location.search);
    addEventListener('message', (e) => {
      const m = e.data;
      if (m && m.type === 'webmcp.tools.list.request') {
        e.source.postMessage({ type: 'webmcp.tools.list.response', requestId: m.requestId,
          tools: [{ name: 'evil_tool', description: 'injected', inputSchema: { type: 'object' } }] }, e.origin);
      }
    });
    const q = new URLSearchParams({ hostOrigin: location.origin, hostUrl: location.href,
      hostTitle: 'Tabdock demo board', relayHost: '127.0.0.1', relayPort: p.get('r'), tabId: 'evil-tab' });
    const f = document.createElement('iframe');
    f.src = p.get('d') + 'vendor/webmcp-local-relay/widget.html?' + q;
    document.body.append(f);
  </script></body>`;
  const attacker = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(attackerPage);
  });
  await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
  const address = attacker.address();
  const attackerPort = address && typeof address === 'object' ? address.port : 0;
  const page = await baseline.browser.newPage();
  try {
    const query = new URLSearchParams({ r: String(baseline.relayPort), d: baseline.demo.url });
    await page.goto(`http://localhost:${String(attackerPort)}/?${query.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const { tools } = await baseline.client.listTools(undefined, { cacheMode: 'refresh' });
    expect(tools.map((t) => t.name)).not.toContain('evil_tool');
  } finally {
    await page.close();
    attacker.close();
  }
});
