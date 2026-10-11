// pnpm demo:m6's guard (S11): every line the demo prints goes through the
// narrator, which hides any secret the run has met and fails the run for
// it, so a code, a token or a link secret that slipped past a mask is never
// printed, not even once. These fakes stand in for the secrets a run meets.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maskLink, Narrator } from '../src/demo-m6/narrator.ts';

const CODE = 'QW3RT-Y7UP9';
const LINK = 'https://relay.test/i#Zm9vYmFyYmF6cXV4cXV1eA';
const SECRET = 'Zm9vYmFyYmF6cXV4cXV1eA';

/** What the narrator printed, line by line. */
function printed(): string[] {
  const log = vi.mocked(console.log);
  return log.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("demo:m6's narrator", () => {
  it('prints a line holding no secret as it is, and counts nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const narrator = new Narrator();
    narrator.remember(CODE);
    narrator.say('   pair_page { code: "QW3RT-*****" }');
    expect(printed()).toEqual(['   pair_page { code: "QW3RT-*****" }']);
    expect(narrator.unexpected).toBe(0);
  });

  it('hides a pairing code it has met, says so, and fails the run', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const narrator = new Narrator();
    narrator.remember(CODE);
    narrator.say(`   pair_page { code: "${CODE}" }`);
    expect(printed().join('\n')).not.toContain(CODE);
    expect(printed()).toContain('   pair_page { code: "[hidden]" }');
    expect(narrator.unexpected).toBe(1);
  });

  it("hides a link's secret and the digest the relay keeps of it", () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const narrator = new Narrator();
    narrator.rememberLink(LINK);
    const digest = createHash('sha256').update(SECRET, 'utf8').digest('hex');
    narrator.say(`   ${LINK} and ${digest}`);
    const text = printed().join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(digest);
    expect(narrator.unexpected).toBe(2);
    expect(maskLink(LINK)).toBe(`https://relay.test/i#${'*'.repeat(SECRET.length)}`);
  });

  it('reads a source of secrets afresh at every line, as the provider issues tokens', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const narrator = new Narrator();
    const issued: string[] = [];
    narrator.rememberFrom(() => issued);
    issued.push('eyJhbGciOiJSUzI1NiJ9.issued-later');
    narrator.say('token eyJhbGciOiJSUzI1NiJ9.issued-later');
    expect(printed().join('\n')).not.toContain('issued-later');
    expect(narrator.unexpected).toBe(1);
  });

  it('names a leak in text it scans without quoting the secret', () => {
    const narrator = new Narrator();
    narrator.remember(CODE);
    const found = narrator.leakIn(`a relay log line with ${CODE} in it`);
    expect(found).not.toBeNull();
    expect(found).not.toContain(CODE);
    expect(narrator.leakIn('a clean line')).toBeNull();
  });
});
