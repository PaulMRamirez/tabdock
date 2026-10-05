// Whom the widget's activity line names for a call the page ran because the
// caller confirmed it in their own client (ADR 0026): the client and the
// person, so the operator sees every call nobody confirmed here. The client's
// name is its own claim, so the widget makes it one plain line whatever the
// relay sent. The widget itself mounts only in a browser; these names are
// worked out without the DOM, and widget.spec.ts checks the badge they fill.

import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../src/core.ts';
import { confirmedIn } from '../src/widget.ts';

const entry: ActivityEntry = {
  callId: 'call-1',
  time: 0,
  user: { userId: 'alice', displayName: 'Alice' },
  client: { name: 'claude-code', version: '2.1.289' },
  tool: 'wipe',
  outcome: 'ok',
  confirmedBy: 'client',
  durationMs: 12,
  handlerRunning: false,
};

describe('confirmedIn', () => {
  it('names the client and the person for a call confirmed in a client', () => {
    expect(confirmedIn(entry)).toEqual({ client: 'claude-code 2.1.289', person: 'Alice' });
  });

  it('names no client when the client gave no name, or one of nothing but invisible characters', () => {
    expect(confirmedIn({ ...entry, client: null })).toEqual({ client: null, person: 'Alice' });
    expect(confirmedIn({ ...entry, client: { name: '', version: '' } })?.client).toBeNull();
    expect(
      confirmedIn({ ...entry, client: { name: '\u202e\u200b', version: '\u2028' } })?.client,
    ).toBeNull();
  });

  it('makes a name the relay passed on unchanged one plain line, whatever it holds', () => {
    const client = {
      name: `claude-code${'\u2003'.repeat(20)}\u202e09:41:07 Bob\u2028via x`,
      version: '2.1.289\u2066',
    };
    expect(confirmedIn({ ...entry, client })).toEqual({
      client: 'claude-code 09:41:07 Bob via x 2.1.289',
      person: 'Alice',
    });
    expect(
      confirmedIn({ ...entry, user: { userId: 'alice', displayName: 'Al\u202eice\u2028' } })
        ?.person,
    ).toBe('Alice');
  });

  it('names nobody for any other call, those the operator confirmed here included', () => {
    expect(confirmedIn({ ...entry, confirmedBy: null })).toBeNull();
  });
});
