import { describe, expect, it } from 'vitest';
import { relayFromQuery } from './relay.ts';

const read = (query: string) => relayFromQuery(new URLSearchParams(query));

describe('relayFromQuery', () => {
  it('is absent without ?relay', () => {
    expect(read('')).toEqual({ kind: 'absent' });
    expect(read('?mcpb=9444')).toEqual({ kind: 'absent' });
  });

  it('accepts ws: and wss: URLs', () => {
    expect(read('?relay=ws://127.0.0.1:8787/page')).toEqual({
      kind: 'ok',
      url: 'ws://127.0.0.1:8787/page',
    });
    expect(read(`?relay=${encodeURIComponent('wss://relay.example/page')}&e2e`)).toEqual({
      kind: 'ok',
      url: 'wss://relay.example/page',
    });
  });

  it('refuses every other scheme, garbage and embedded credentials', () => {
    for (const value of [
      'http://127.0.0.1:8787/page',
      'https://relay.example/page',
      'javascript:alert(1)',
      'not a url',
      '',
      'ws://user:secret@relay.example/page',
    ]) {
      expect(read(`?relay=${encodeURIComponent(value)}`).kind, value).toBe('invalid');
    }
  });
});
