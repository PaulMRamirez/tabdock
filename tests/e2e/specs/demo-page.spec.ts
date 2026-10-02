import { expect, test } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { DEMO_TOOL_NAMES } from '../src/harness.ts';

// The demo page on its own: tools registered through WebMCP (polyfill or native)
// and called the way an in-page adapter will call them.

let demo: DemoServer;
test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});

interface Ctx {
  getTools(): Promise<{ name: string; annotations?: Record<string, boolean> }[]>;
  executeTool(tool: object, input: unknown): Promise<string>;
}

test('registers the six demo tools with read-only hints on the reads', async ({ page }) => {
  await page.goto(demo.url);
  await page.waitForSelector('html[data-tools="ready"]');
  const tools = await page.evaluate(async () => {
    const mc = (document as unknown as { modelContext: Ctx }).modelContext;
    return (await mc.getTools()).map((t) => ({
      name: t.name,
      readOnly: t.annotations?.readOnlyHint,
    }));
  });
  expect(tools.map((t) => t.name)).toEqual([...DEMO_TOOL_NAMES]);
  const readOnly = tools.filter((t) => t.readOnly).map((t) => t.name);
  expect(readOnly).toEqual(['get_view', 'list_items']);
  await expect(page.locator('[data-role="status"]')).toHaveText(/6 tools registered/);
});

test('a call through executeTool changes the board and shows in the activity log', async ({
  page,
}) => {
  await page.goto(demo.url);
  await page.waitForSelector('html[data-tools="ready"]');
  const raw = await page.evaluate(async () => {
    const mc = (document as unknown as { modelContext: Ctx }).modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === 'add_item');
    if (!tool) throw new Error('add_item missing');
    const args = { label: 'From test', x: 40, y: 40, color: 'purple' };
    // Chrome 153 and 154 and the MCP-B polyfill take a JSON string; Chrome 155+ takes an object.
    try {
      return await mc.executeTool(tool, args);
    } catch {
      return await mc.executeTool(tool, JSON.stringify(args));
    }
  });
  expect(JSON.parse(raw)).toMatchObject({ item: { id: 'item-4', label: 'From test' } });
  await expect(page.locator('[data-role="log"] li').first()).toHaveText(/add_item: added item-4/);
  await expect(page.locator('[data-role="view"]')).toHaveText(/4 items/);
});
