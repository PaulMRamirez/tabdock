// What the widget's activity line says of a call the page ran because the
// caller confirmed it in their own client (ADR 0026): the client and the
// person, so the operator sees every call nobody confirmed here. The widget
// itself mounts only in a browser; this text is built without the DOM.

import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../src/core.ts';
import { confirmedText } from '../src/widget.ts';

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

describe('confirmedText', () => {
  it('names the client and the person for a call confirmed in a client', () => {
    expect(confirmedText(entry)).toBe(', confirmed in claude-code 2.1.289 by Alice');
  });

  it('says "their client" when the client gave no name', () => {
    expect(confirmedText({ ...entry, client: null })).toBe(', confirmed in their client by Alice');
    expect(confirmedText({ ...entry, client: { name: '', version: '' } })).toBe(
      ', confirmed in their client by Alice',
    );
  });

  it('adds nothing for any other call, those the operator confirmed here included', () => {
    expect(confirmedText({ ...entry, confirmedBy: null })).toBe('');
  });
});
