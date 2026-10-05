import { describe, expect, it } from 'vitest';
import { checkRelayUrl, relayFromQuery } from './relay.ts';

const read = (query: string) => relayFromQuery(new URLSearchParams(query));

describe('relayFromQuery', () => {
  it('is absent without ?relay', () => {
    expect(read('')).toEqual({ kind: 'absent' });
    expect(read('?mcpb=9444')).toEqual({ kind: 'absent' });
  });

  it('accepts ws: and wss: URLs, naming the host the Connect bar shows', () => {
    expect(read('?relay=ws://127.0.0.1:8787/page')).toEqual({
      kind: 'ok',
      url: 'ws://127.0.0.1:8787/page',
      host: '127.0.0.1:8787',
    });
    expect(read(`?relay=${encodeURIComponent('wss://relay.example/page')}&e2e`)).toEqual({
      kind: 'ok',
      url: 'wss://relay.example/page',
      host: 'relay.example',
    });
  });

  it('names an internationalised host in punycode, with its port, so a look-alike shows as itself', () => {
    expect(read(`?relay=${encodeURIComponent('wss://bücher.example:444/page')}`)).toEqual({
      kind: 'ok',
      url: 'wss://xn--bcher-kva.example:444/page',
      host: 'xn--bcher-kva.example:444',
    });
  });

  it('asks an https page for wss:, except for a relay on this machine', () => {
    const onHttps = (value: string) =>
      relayFromQuery(new URLSearchParams({ relay: value }), 'https:');
    expect(onHttps('wss://relay.example/page')).toMatchObject({
      kind: 'ok',
      url: 'wss://relay.example/page',
    });
    expect(onHttps('ws://relay.example/page')).toEqual({
      kind: 'invalid',
      message: '?relay must be a wss: URL on an https page',
    });
    for (const value of [
      'ws://127.0.0.1:8787/page',
      'ws://localhost:8787/page',
      'ws://[::1]:8787/page',
    ]) {
      expect(onHttps(value).kind, value).toBe('ok');
    }
    // A plain http page, as the dev server serves, may dial ws: anywhere it likes.
    expect(read('?relay=ws://relay.example/page').kind).toBe('ok');
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

  it('refuses a relay URL with a query or a fragment, even an empty one (ADR 0029)', () => {
    for (const value of [
      'wss://relay.example/page?token=abc',
      'wss://relay.example/page?',
      'wss://relay.example/page#x',
      'wss://relay.example/page#',
      'ws://127.0.0.1:8787/page?#',
      'ws://127.0.0.1:8787/?',
    ]) {
      expect(read(`?relay=${encodeURIComponent(value)}`), value).toEqual({
        kind: 'invalid',
        message: '?relay must not carry a query or a fragment',
      });
    }
    // A ? or # kept as data inside the path is percent-encoded, so it is no query.
    expect(read(`?relay=${encodeURIComponent('wss://relay.example/a%3Fb%23c')}`).kind).toBe('ok');
  });
});

describe('checkRelayUrl, as the Connect form uses it', () => {
  it('names where the URL came from in its message', () => {
    expect(checkRelayUrl('wss://relay.example/page?x', 'https:', 'The relay URL')).toEqual({
      kind: 'invalid',
      message: 'The relay URL must not carry a query or a fragment',
    });
    expect(checkRelayUrl('ws://relay.example/page', 'https:', 'The relay URL')).toEqual({
      kind: 'invalid',
      message: 'The relay URL must be a wss: URL on an https page',
    });
    expect(checkRelayUrl('wss://relay.example/page', 'https:', 'The relay URL')).toEqual({
      kind: 'ok',
      url: 'wss://relay.example/page',
      host: 'relay.example',
    });
  });
});
