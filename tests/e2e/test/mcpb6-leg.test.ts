// The MCP-B 6 leg's wiring (A5.4 and A6.26; ADR 0047 moved it from the beta
// of ADR 0031 to 6.0.0). Its specs prove the runtime in the browser before
// they trust a result; these checks keep the leg running at all: `pnpm
// test:e2e` must reach specs/mcpb6.spec.ts and, from M6, A6.3's
// specs/mcpb6-images.spec.ts in a project of its own, with no flag that could
// turn native WebMCP on and make the polyfill keep Chrome's context, while
// every other spec keeps the flag (a narrowed pattern would move the image
// spec back to chromium unnoticed); and the init script must
// carry 6.0.0's ESM entry, reached through @tabdock/mcpb6 (ADR 0032), never
// 5.1.0's, and call installWebMCP() itself, since importing 6.0.0 installs
// nothing.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPB6_POLYFILL_MODULE, MCPB6_POLYFILL_SCRIPT, mcpb6ModuleScript } from '@tabdock/mcpb6';
import { describe, expect, it } from 'vitest';
import config from '../playwright.config.ts';
import { MCPB6_BINDING, mcpb6InitScript } from '../src/mcpb6-page.ts';

const SPECS = fileURLToPath(new URL('../specs', import.meta.url));

interface Project {
  name?: string;
  testMatch?: unknown;
  testIgnore?: unknown;
  use?: { launchOptions?: { args?: string[] } };
}

function project(name: string): Project {
  const found = (config.projects as Project[] | undefined)?.find((p) => p.name === name);
  if (!found) throw new Error(`playwright.config.ts has no project ${name}`);
  return found;
}

/** Whether a Playwright testMatch or testIgnore pattern takes a spec file. */
function matches(pattern: unknown, file: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(join(SPECS, file));
  return false;
}

describe('the MCP-B 6.0.0 leg (ADRs 0031 and 0047)', () => {
  it('runs specs/mcpb6.spec.ts and specs/mcpb6-images.spec.ts in their own project and no other spec there', () => {
    const leg = project('mcpb6');
    const main = project('chromium');
    for (const spec of ['mcpb6.spec.ts', 'mcpb6-images.spec.ts']) {
      expect(existsSync(join(SPECS, spec)), spec).toBe(true);
      expect(matches(leg.testMatch, spec), spec).toBe(true);
      expect(matches(main.testIgnore, spec), spec).toBe(true);
    }
    for (const other of ['tabdock-relay.spec.ts', 'widget.spec.ts', 'mcpb-relay.spec.ts']) {
      expect(matches(leg.testMatch, other), other).toBe(false);
      expect(matches(main.testIgnore, other), other).toBe(false);
    }
    expect(config.projects?.map((p) => p.name)).toEqual(['chromium', 'mcpb6']);
  });

  // Read from the specs directory as it stands, so a new mcpb6 spec the
  // pattern misses, or a pattern narrowed to mcpb6.spec.ts alone, fails here.
  it('runs every mcpb6*.spec.ts under specs/ in the leg, and every other spec in chromium', () => {
    const leg = project('mcpb6');
    const main = project('chromium');
    const specs = readdirSync(SPECS, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.spec.ts'),
    );
    const onLeg = (file: string): boolean => basename(file).startsWith('mcpb6');
    expect(specs.filter(onLeg)).toEqual(
      expect.arrayContaining(['mcpb6.spec.ts', 'mcpb6-images.spec.ts']),
    );
    expect(specs.length).toBeGreaterThan(10);
    for (const spec of specs) {
      expect(matches(leg.testMatch, spec), spec).toBe(onLeg(spec));
      expect(matches(main.testIgnore, spec), spec).toBe(onLeg(spec));
    }
  });

  it('launches the leg without the flag that turns native WebMCP on, and the rest with it', () => {
    expect(project('mcpb6').use?.launchOptions?.args ?? []).not.toContain(
      '--enable-features=WebMCPTesting',
    );
    expect(project('chromium').use?.launchOptions?.args).toContain(
      '--enable-features=WebMCPTesting',
    );
  });

  it("injects 6.0.0's ESM entry alone and calls installWebMCP() after it", () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(MCPB6_POLYFILL_MODULE)), 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(manifest).toMatchObject({ name: '@mcp-b/webmcp-polyfill', version: '6.0.0' });
    const bundled = mcpb6ModuleScript(MCPB6_BINDING);
    expect(bundled.inputs).toEqual([MCPB6_POLYFILL_MODULE]);
    // The script-tag build installs itself as it loads, which would hide whether the call is needed.
    const selfInstalling = readFileSync(MCPB6_POLYFILL_SCRIPT, 'utf8');
    for (const recordCalls of [true, false]) {
      const script = mcpb6InitScript({ recordCalls });
      expect(script).toContain(bundled.script);
      expect(script).not.toContain(selfInstalling.slice(0, 200));
      // Read once the module has run and before the call, then the call itself.
      const read = script.indexOf("probe.installedOnImport = 'modelContext' in document;");
      const call = script.indexOf(`${MCPB6_BINDING}.installWebMCP();`);
      expect(script.indexOf(bundled.script)).toBeLessThan(read);
      expect(read).toBeLessThan(call);
      // 5.1.0's initializer is what the demo calls; 6 exports only installWebMCP.
      expect(script).not.toContain('initializeWebMCPPolyfill');
    }
    expect(mcpb6InitScript({ recordCalls: false })).not.toContain('Object.defineProperty(context');
  });
});
