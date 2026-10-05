// The MCP-B 6.0 beta leg's wiring (A5.4, ADR 0031). Its specs prove the
// runtime in the browser before they trust a result; these checks keep the
// leg running at all: `pnpm test:e2e` must reach specs/mcpb6.spec.ts in a
// project of its own, with no flag that could turn native WebMCP on and make
// the beta polyfill keep Chrome's context, while every other spec keeps the
// flag; and the init script must carry the beta's own bytes, reached through
// @tabdock/mcpb6 (ADR 0032), never 5.1.0's.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPB6_POLYFILL_SCRIPT } from '@tabdock/mcpb6';
import { describe, expect, it } from 'vitest';
import config from '../playwright.config.ts';
import { mcpb6InitScript } from '../src/mcpb6-page.ts';

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

describe('the MCP-B 6.0 beta leg (ADR 0031)', () => {
  it('runs specs/mcpb6.spec.ts in its own project and no other spec there', () => {
    const leg = project('mcpb6');
    const main = project('chromium');
    expect(matches(leg.testMatch, 'mcpb6.spec.ts')).toBe(true);
    expect(matches(main.testIgnore, 'mcpb6.spec.ts')).toBe(true);
    for (const other of ['tabdock-relay.spec.ts', 'widget.spec.ts', 'mcpb-relay.spec.ts']) {
      expect(matches(leg.testMatch, other), other).toBe(false);
      expect(matches(main.testIgnore, other), other).toBe(false);
    }
    expect(config.projects?.map((p) => p.name)).toEqual(['chromium', 'mcpb6']);
  });

  it('launches the leg without the flag that turns native WebMCP on, and the rest with it', () => {
    expect(project('mcpb6').use?.launchOptions?.args ?? []).not.toContain(
      '--enable-features=WebMCPTesting',
    );
    expect(project('chromium').use?.launchOptions?.args).toContain(
      '--enable-features=WebMCPTesting',
    );
  });

  it("injects the beta polyfill's own script-tag build", () => {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(MCPB6_POLYFILL_SCRIPT)), 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(manifest.name).toBe('@mcp-b/webmcp-polyfill');
    expect(manifest.version).toMatch(/^6\.0\.0-beta\./);
    const polyfill = readFileSync(MCPB6_POLYFILL_SCRIPT, 'utf8');
    for (const recordCalls of [true, false]) {
      const script = mcpb6InitScript({ recordCalls });
      expect(script).toContain(polyfill);
      // 5.1.0's initializer is what the demo calls; the beta exports only installWebMCP.
      expect(script).not.toContain('initializeWebMCPPolyfill');
    }
    expect(mcpb6InitScript({ recordCalls: false })).not.toContain('Object.defineProperty(context');
  });
});
