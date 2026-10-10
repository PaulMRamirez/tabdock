// A6.3 end to end, with nothing mocked between client and handler: a sim
// page runs the real adapter core over each runtime the suite plays, MCP-B 6
// among them, and a real relay passes its declared image tools' pictures to
// SDK clients on both revisions, by call_page_tool and by first-class name.
// The image arrives byte for byte as the page drew it, behind the label and
// the relay's line, with the page's words beside it; the same envelope from a
// tool the page did not declare stays text, as each runtime gave it; and the
// operator's activity log and the audit name the image's type and size.

import { createHash } from 'node:crypto';
import {
  ALL_RUNTIME_PROFILES,
  createDefaultTools,
  createImageTools,
  DEFAULT_SIM_ORIGIN,
  IMAGE_TOOL_NAMES,
  type RuntimeProfile,
} from '@tabdock/sim-page';
import { imageLine, untrustedHeader } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  firstText,
  imageBytes,
  imagePart,
  pngDimensions,
  type ResultContent,
} from '../src/image-helpers.ts';
import {
  attachAs,
  callTool,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  type World,
} from './helpers.ts';

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const IMAGE_TOOLS = (raw: () => unknown = () => undefined) => ({
  tools: (store: Parameters<typeof createDefaultTools>[0]) => [
    ...createDefaultTools(store),
    ...createImageTools({ raw }),
  ],
});

/** Every profile on both MCP revisions. */
const CASES = ALL_RUNTIME_PROFILES.flatMap((profile) =>
  [false, true].map((modern) => ({ profile, modern })),
);

function leg(modern: boolean): string {
  return modern ? '2026-07-28' : '2025-11-25';
}

describe.each(CASES)('a declared image tool on $profile', ({ profile, modern }) => {
  it(`reaches an SDK client whole behind its label, by either route (${leg(modern)})`, async () => {
    world = await startWorld({ firstClassTools: true });
    const sim = await world.page({
      profile,
      policy: { imageTools: [...IMAGE_TOOL_NAMES] },
      ...IMAGE_TOOLS(),
    });
    const alice = await world.client(world.alice, 'e2e-images', { modern });
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT + IMAGE_TOOL_NAMES.length);
    for (const [name, args] of [
      ['call_page_tool', { page: pageId, tool: 'capture', arguments: { width: 20, height: 10 } }],
      // The envelope written as text, which MCP-B 6 quotes once more.
      [
        'call_page_tool',
        { page: pageId, tool: 'capture_string', arguments: { width: 20, height: 10 } },
      ],
      [`${pageId}__capture`, { width: 20, height: 10 }],
    ] as const) {
      const result = (await alice.callTool({ name, arguments: args })) as ResultContent;
      const what = `${profile} ${name} ${JSON.stringify(args)}`;
      expect(result.isError, what).toBeFalsy();
      expect(result.structuredContent, what).toBeUndefined();
      expect(
        result.content.map((block) => block.type),
        what,
      ).toEqual(['text', 'image']);
      const image = imagePart(result);
      if (image === null) throw new Error('no image part');
      const bytes = imageBytes(image);
      expect(image.mimeType).toBe('image/png');
      expect(pngDimensions(bytes), what).toEqual({ width: 20, height: 10 });
      const tool = name === 'call_page_tool' ? args.tool : 'capture';
      expect(firstText(result), what).toBe(
        `${untrustedHeader(DEFAULT_SIM_ORIGIN, tool)}\n${imageLine('image/png', bytes.length)}\nA 20 by 10 test card`,
      );
    }
    // The operator sees each picture's type and size; the audit, its digest too.
    const entry = sim.state.activity[0];
    expect(entry?.image?.mimeType).toBe('image/png');
    const records = world.relay.audit.records();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({ outcome: 'ok', image: { mimeType: 'image/png' } });
      expect(record.image?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe.each(ALL_RUNTIME_PROFILES)('an undeclared tool on %s', (profile: RuntimeProfile) => {
  it('returns the same envelope as text, as the runtime gave it', async () => {
    world = await startWorld();
    const sim = await world.page({ profile, ...IMAGE_TOOLS() });
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT + IMAGE_TOOL_NAMES.length);
    for (const tool of ['capture', 'capture_string']) {
      const result = (await alice.callTool({
        name: 'call_page_tool',
        arguments: { page: pageId, tool, arguments: { width: 4, height: 4 } },
      })) as ResultContent;
      expect(result.isError).toBeFalsy();
      expect(imagePart(result)).toBeNull();
      const text = firstText(result).split('\n').slice(1).join('\n');
      // An object is its JSON everywhere; a string arrives quoted only on MCP-B 6.
      const envelope: unknown = JSON.parse(text);
      const inner = typeof envelope === 'string' ? (JSON.parse(envelope) as unknown) : envelope;
      expect(typeof envelope === 'string').toBe(profile === 'mcpb-6' && tool === 'capture_string');
      expect(inner).toMatchObject({ image: { mimeType: 'image/png' }, text: 'A 4 by 4 test card' });
    }
    expect(world.relay.audit.records().every((record) => record.image === undefined)).toBe(true);
  });
});

describe('a declared image tool for an observer, and a crafted envelope (A6.3, A6.4)', () => {
  it('lets an observer take the picture, and refuses an SVG in the page before it is sent', async () => {
    let raw: unknown = undefined;
    world = await startWorld();
    const sim = await world.page({
      policy: { imageTools: [...IMAGE_TOOL_NAMES] },
      ...IMAGE_TOOLS(() => raw),
    });
    const bob = await world.client(world.bob);
    const pageId = await attachAs(bob, sim, 'observer');
    await waitForTools(bob, pageId, SIM_TOOL_COUNT + IMAGE_TOOL_NAMES.length);
    const taken = (await bob.callTool({
      name: 'call_page_tool',
      arguments: { page: pageId, tool: 'capture', arguments: {} },
    })) as ResultContent;
    expect(imagePart(taken)?.mimeType).toBe('image/png');
    raw = { image: { mimeType: 'image/svg+xml', data: 'PHN2Zy8+' } };
    const svg = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'image_raw' });
    expect(svg.isError).toBe(true);
    expect(svg.text).toContain('the image is not PNG, JPEG or WebP');
    // The page refused it, so no image reached the relay: an ordinary tool_error.
    expect(world.relay.audit.records().at(-1)).toMatchObject({ outcome: 'tool_error' });
    expect(world.relay.audit.records().at(-1)).not.toHaveProperty('imageRefused');
    // The digest names the bytes the client received.
    const image = imagePart(taken);
    if (image === null) throw new Error('no image part');
    expect(world.relay.audit.records()[0]?.image?.sha256).toBe(
      createHash('sha256').update(imageBytes(image)).digest('hex'),
    );
  });
});
