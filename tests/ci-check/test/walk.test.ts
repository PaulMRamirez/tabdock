// The walker catches a broken page (ADR 0041, decision 15). A real page is
// never broken on purpose, so these hold the walker to five kinds of drift on
// a scripted page, each giving exactly one finding named by where and what,
// and a consistent page giving none; a walker that asserted nothing would
// pass every broken page here and fail.

import { describe, expect, it } from 'vitest';
import { difference, type Finding, walkPage } from '../src/walk.ts';
import { type Faults, PAGE_ID, scriptedPage } from './scripted-page.ts';

/** Short, since the scripted page publishes at once or never. */
const OPTIONS = { stateTimeoutMs: 100 };

async function walk(faults: Faults = {}): Promise<{ findings: Finding[]; calls: string[] }> {
  const { call, calls } = scriptedPage(faults);
  return { findings: await walkPage(call, PAGE_ID, OPTIONS), calls };
}

describe('walkPage', () => {
  it('finds nothing on a consistent page, after checking every stop, observation and capture', async () => {
    let planned: { stops: number; observations: number } | null = null;
    const steps: string[] = [];
    const { call, calls } = scriptedPage();
    const findings = await walkPage(call, PAGE_ID, {
      ...OPTIONS,
      planned: (size) => {
        planned = size;
      },
      step: async (title, body) => {
        steps.push(title);
        await body();
      },
    });
    expect(findings).toEqual([]);
    expect(planned).toEqual({ stops: 2, observations: 1 });
    expect(steps).toEqual(['tour stop 0', 'tour stop 1', 'observation obs-1']);
    expect(calls.filter((name) => name === 'call_page_tool capture_view')).toHaveLength(2);
    expect(calls).toContain('call_page_tool list_observations');
    expect(calls).toContain('get_page_state');
  });

  it('1. finds a stop whose view drifts by half a degree', async () => {
    const { findings } = await walk({ viewDrift: { index: 1, degrees: 0.5 } });
    expect(findings).toEqual([
      {
        walkthrough: 'tour',
        stop: 1,
        observation: null,
        check: 'view',
        expected: 'lon=179.5',
        got: 'lon=180',
      },
    ]);
  });

  it('2. finds an observation that lands off its viewpoint', async () => {
    const { findings } = await walk({ viewpointDrift: 0.25 });
    expect(findings).toEqual([
      {
        walkthrough: null,
        stop: null,
        observation: 'obs-1',
        check: 'viewpoint',
        expected: 'lat=-10',
        got: 'lat=-9.75',
      },
    ]);
  });

  it('3. finds state that never reaches a stop', async () => {
    const { findings } = await walk({ stateStuckAt: 1 });
    expect(findings).toEqual([
      {
        walkthrough: 'tour',
        stop: 1,
        observation: null,
        check: 'state',
        expected: 'walkthrough tour stop 1',
        got: 'none within 100 ms',
      },
    ]);
  });

  it('4. finds state whose view differs from what get_view answers', async () => {
    const { findings } = await walk({ stateViewOffAt: 0 });
    expect(findings).toEqual([
      {
        walkthrough: 'tour',
        stop: 0,
        observation: null,
        check: 'state-view',
        expected: 'widthM=900000',
        got: 'widthM=1350000',
      },
    ]);
  });

  it('5. finds a result with no label line, and goes on with the next stop', async () => {
    const { findings, calls } = await walk({ unlabelled: 'get_stop' });
    expect(findings).toEqual([
      {
        walkthrough: 'tour',
        stop: 0,
        observation: null,
        check: 'result',
        expected: 'get_stop answered',
        got: 'no label',
      },
      {
        walkthrough: 'tour',
        stop: 1,
        observation: null,
        check: 'result',
        expected: 'get_stop answered',
        got: 'no label',
      },
    ]);
    // One bad stop never hides the rest: the observation was still walked.
    expect(calls).toContain('call_page_tool view_from_observation');
  });

  it('finds a capture that is no PNG, whatever type it names', async () => {
    const notPng = await walk({ captureNotPng: true });
    expect(
      notPng.findings.map(({ stop, check, expected, got }) => [stop, check, expected, got]),
    ).toEqual([
      [0, 'capture', 'image/png', 'not a PNG'],
      [1, 'capture', 'image/png', 'not a PNG'],
    ]);
    const mislabelled = await walk({ captureMimeType: 'image/jpeg' });
    expect(mislabelled.findings.map(({ stop, check, got }) => [stop, check, got])).toEqual([
      [0, 'capture', 'image/jpeg'],
      [1, 'capture', 'image/jpeg'],
    ]);
  });

  it('finds a capture larger than the image cap, and takes one at the cap', async () => {
    const over = scriptedPage({ captureBytes: 65 });
    const findings = await walkPage(over.call, PAGE_ID, { ...OPTIONS, maxImageBytes: 64 });
    expect(findings.map(({ stop, check, expected, got }) => [stop, check, expected, got])).toEqual([
      [0, 'capture', 'at most 64 bytes', '65 bytes'],
      [1, 'capture', 'at most 64 bytes', '65 bytes'],
    ]);
    const at = scriptedPage({ captureBytes: 64 });
    expect(await walkPage(at.call, PAGE_ID, { ...OPTIONS, maxImageBytes: 64 })).toEqual([]);
  });

  it('skips a group the page does not list, unless the walk requires it', async () => {
    const unlisted = ['capture_view', 'list_observations'];
    const skipped = await walk({ unlisted });
    expect(skipped.findings).toEqual([]);
    expect(skipped.calls).not.toContain('call_page_tool capture_view');
    const { call, calls } = scriptedPage({ unlisted });
    const required = await walkPage(call, PAGE_ID, {
      ...OPTIONS,
      requireTools: ['get_clock', 'capture_view', 'list_observations'],
    });
    expect(required).toEqual(
      unlisted.map((name) => ({
        walkthrough: null,
        stop: null,
        observation: null,
        check: 'tools',
        expected: name,
        got: 'not listed',
      })),
    );
    expect(calls).toEqual(['list_pages', 'list_page_tools']);
  });

  it('finds a capture that carries no image, and a caller that is no driver', async () => {
    const noImage = await walk({ noImage: true });
    expect(noImage.findings.map(({ stop, check, got }) => [stop, check, got])).toEqual([
      [0, 'capture', 'none'],
      [1, 'capture', 'none'],
    ]);
    const observer = await walk({ observer: true });
    expect(observer.findings).toEqual([
      {
        walkthrough: null,
        stop: null,
        observation: null,
        check: 'role',
        expected: 'driver',
        got: 'observer',
      },
    ]);
    expect(observer.calls).toEqual(['list_pages']);
  });
});

describe('difference', () => {
  it('takes angles within 1e-6 degrees and metres within a relative 1e-6 as the same', () => {
    expect(
      difference({ lon: 10, widthM: 1e6 }, { lon: 10 + 9e-7, widthM: 1e6 * (1 + 9e-7) }),
    ).toBeNull();
    expect(difference({ lon: 10 }, { lon: 10 + 2e-6 })).toEqual({
      expected: 'lon=10',
      got: 'lon=10.000002',
    });
    expect(difference({ widthM: 1e6 }, { widthM: 1e6 * (1 + 2e-6) })).not.toBeNull();
    // -180 and 180 are one longitude, and 359.9999999 degrees is north.
    expect(
      difference({ lon: -180, headingDeg: 0 }, { lon: 180, headingDeg: 359.9999999 }),
    ).toBeNull();
    expect(difference({ body: 'moon' }, { body: 'mars' })).toEqual({
      expected: 'body=moon',
      got: 'body=mars',
    });
    expect(difference({ a: 1 }, {})).toEqual({ expected: 'a=1', got: 'a=absent' });
  });
});
