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

  it("hides a phone's sign-in cookies and the code, state and nonce its sign-in carried", () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const narrator = new Narrator();
    const session = 'c2Vzc2lvbi1zZWNyZXQtb2YtYS1waG9uZQ';
    const login = 'bG9naW4taW4tcHJvZ3Jlc3M';
    narrator.rememberSignIn({
      setCookies: [{ value: login }, { value: '' }, { value: session }],
      requested: [
        'https://relay.test/pair/login?to=i',
        'https://issuer.test/authorize?client_id=tabdock-pair&state=c3RhdGUtdmFsdWU&nonce=bm9uY2UtdmFsdWU',
        'https://relay.test/pair/callback?code=Y29kZS1mcm9tLXByb3ZpZGVy&state=c3RhdGUtdmFsdWU',
      ],
    });
    const line = `cookie ${session} ${login}, code Y29kZS1mcm9tLXByb3ZpZGVy, state c3RhdGUtdmFsdWU, nonce bm9uY2UtdmFsdWU`;
    narrator.say(line);
    const text = printed().join('\n');
    for (const secret of [
      session,
      login,
      'Y29kZS1mcm9tLXByb3ZpZGVy',
      'c3RhdGUtdmFsdWU',
      'bm9uY2UtdmFsdWU',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(narrator.leakIn(`the relay logged ${session}`)).not.toBeNull();
    // What a sign-in names openly, its client and where it goes, is no secret.
    expect(narrator.leakIn('client tabdock-pair returned to i')).toBeNull();
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
