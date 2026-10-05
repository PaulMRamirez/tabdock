import { describe, expect, it } from 'vitest';
import {
  CHOICE_KEY_PREFIX,
  type ChoiceStore,
  choiceKey,
  connectHref,
  rememberChoice,
  wasChosen,
} from './connect.ts';

function memoryStore(): ChoiceStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe('the remembered choice of relay (ADR 0029)', () => {
  it('remembers exactly the relay URL chosen, and no other', () => {
    const store = memoryStore();
    expect(wasChosen(store, 'wss://relay.example/page')).toBe(false);
    rememberChoice(store, 'wss://relay.example/page');
    expect(wasChosen(store, 'wss://relay.example/page')).toBe(true);
    for (const other of [
      'wss://relay.example/page2',
      'wss://relay.example:444/page',
      'ws://relay.example/page',
      'wss://evil.example/page',
    ]) {
      expect(wasChosen(store, other), other).toBe(false);
    }
  });

  it("keeps its records under a prefix of the demo's own, apart from the adapter's tabdock: keys", () => {
    const store = memoryStore();
    rememberChoice(store, 'wss://relay.example/page');
    expect([...store.entries]).toEqual([['tabdock-demo:connect:wss://relay.example/page', '1']]);
    expect(choiceKey('x').startsWith(CHOICE_KEY_PREFIX)).toBe(true);
    expect(CHOICE_KEY_PREFIX.startsWith('tabdock:')).toBe(false);
  });

  it('remembers nothing, and so asks again, where storage is missing or throws', () => {
    expect(wasChosen(null, 'wss://relay.example/page')).toBe(false);
    rememberChoice(null, 'wss://relay.example/page');
    const refusing: ChoiceStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => {
      rememberChoice(refusing, 'wss://relay.example/page');
    }).not.toThrow();
    expect(wasChosen(refusing, 'wss://relay.example/page')).toBe(false);
  });

  it('only a stored "1" counts as a choice', () => {
    const store = memoryStore();
    store.entries.set(choiceKey('wss://relay.example/page'), 'true');
    expect(wasChosen(store, 'wss://relay.example/page')).toBe(false);
  });
});

describe('connectHref, where the Connect form goes', () => {
  it("sets ?relay and keeps the page's other parameters, dropping any hash", () => {
    expect(
      connectHref('https://board.example/?invites=all&e2e#x', 'wss://relay.example/page'),
    ).toBe('https://board.example/?invites=all&e2e=&relay=wss%3A%2F%2Frelay.example%2Fpage');
    expect(
      connectHref('http://127.0.0.1:5173/?relay=ws://old/page', 'ws://127.0.0.1:8787/page'),
    ).toBe('http://127.0.0.1:5173/?relay=ws%3A%2F%2F127.0.0.1%3A8787%2Fpage');
  });

  it('keeps a subpath, so a copy under <user>.github.io/<repository>/ stays where it is', () => {
    expect(connectHref('https://user.github.io/tabdock/', 'wss://relay.example/page')).toBe(
      'https://user.github.io/tabdock/?relay=wss%3A%2F%2Frelay.example%2Fpage',
    );
  });
});
