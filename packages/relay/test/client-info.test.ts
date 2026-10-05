// A client's name and version are its own claim (SPEC section 5), and the
// relay hands them on: to the page, whose widget shows them to the operator
// on the same line as the page's own words, to the audit log and to its own
// lines. So parseClientInfo keeps one plain line of each: no control, format
// or bidirectional character, no line or paragraph separator, and every run
// of spaces of any kind one space. A name could otherwise wrap its rest into
// a line that passes for another entry, or reverse the page's words after it.

import { afterEach, describe, expect, it } from 'vitest';
import { parseClientInfo } from '../src/mcp.ts';
import { ALICE, startRelay, type TestRelay } from './helpers/relay.ts';
import { legacyInitialize } from './helpers/wire.ts';

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('parseClientInfo', () => {
  it('keeps a name and version that break no line and reorder nothing as they are', () => {
    expect(parseClientInfo({ name: 'claude-code', version: '2.1.289' })).toEqual({
      name: 'claude-code',
      version: '2.1.289',
    });
  });

  it('drops format and bidirectional characters, and makes every break or run of spaces one space', () => {
    expect(
      parseClientInfo({
        name: `Claude${'\u2003'.repeat(20)}\u202e09:41:07 Bob\u2028via\u0000claude\u200b-code\u2066`,
        version: ' 2.1.289\u2029by\u00a0\u00a0Bob\r\n',
      }),
    ).toEqual({ name: 'Claude 09:41:07 Bob via claude-code', version: '2.1.289 by Bob' });
  });

  it('caps each, and leaves no half of a surrogate pair where the cap cut one', () => {
    const parsed = parseClientInfo({ name: `${'a'.repeat(99)}\u{1f600}`, version: '1'.repeat(80) });
    expect(parsed).toEqual({ name: 'a'.repeat(99), version: '1'.repeat(50) });
  });

  it('gives null for a client that names itself with anything but two strings', () => {
    expect(parseClientInfo({ name: 'x' })).toBeNull();
    expect(parseClientInfo('x')).toBeNull();
    expect(parseClientInfo(null)).toBeNull();
  });

  it("names a session's client in the relay's own line as parsed", async () => {
    current = await startRelay({ logLevel: 'info' });
    await legacyInitialize(current.relay, ALICE, {}, 'claude\u202e-code\u2028x');
    const lines = current.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'mcp client');
    expect(lines.map((line) => line.client)).toEqual(['claude-code x']);
  });
});
