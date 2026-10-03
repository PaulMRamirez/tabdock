// The M3 soak's freeze, thaw and resume cycle, once and quickly, so the logic
// behind pnpm spike:soak runs in CI (A3.3). The relay's idle timeout is cut to
// a few seconds so a short freeze still drops the link at the relay. The
// browser is launched and frozen over raw CDP (src/spike/cdp.ts), not through
// Playwright's page, whose focus emulation keeps a page from freezing.

import { expect, test } from '@playwright/test';
import { cycleOk, runSoak, soakReport } from '../src/spike/soak.ts';

test('a frozen tab comes back with the same page, its attachment and a working call', async () => {
  test.setTimeout(90_000);
  const lines: string[] = [];
  const options = {
    durationMs: 60_000,
    maxCycles: 1,
    freezeMs: 5000,
    activeMs: 500,
    resumeTimeoutMs: 30_000,
    timings: { pingIntervalMs: 1000, idleTimeoutMs: 2500 },
    say: (line: string) => lines.push(line),
  };
  const report = await runSoak(options);
  expect(report.cycles).toHaveLength(1);
  const [cycle] = report.cycles;
  if (!cycle) throw new Error('no cycle ran');
  expect(cycle.error).toBeNull();
  // The freeze really cut the link: the relay heard nothing and put the page to sleep.
  expect(cycle.relayDroppedAt).not.toBeNull();
  expect((cycle.relayDroppedAt ?? 0) - cycle.frozeAt).toBeLessThan(options.freezeMs);
  // And the page saw its socket fail once it thawed, then resumed the same session.
  expect(cycle.pageDroppedAt).not.toBeNull();
  expect(cycle.resumed).toBe(true);
  expect(cycle).toMatchObject({ samePage: true, attached: true, callOk: true });
  expect(cycleOk(cycle)).toBe(true);
  expect(report.ok).toBe(true);
  // A frozen page is hidden, and stays hidden after it thaws, as a background tab would.
  expect(report.visibility).toBe('hidden');
  expect(report.wasDiscarded).toBe(false);

  const markdown = soakReport(report, options);
  expect(markdown).toContain('| Thaw to first working call | 1 |');
  expect(markdown).toContain('Every cycle came back');
  expect(lines.some((line) => line.includes('reconnected at'))).toBe(true);
});
