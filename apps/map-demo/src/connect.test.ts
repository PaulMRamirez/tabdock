// The map demo's remembered choice of relay (ADR 0050): it is keyed on the
// relay URL alone, under a prefix of its own, so a relay chosen on the board
// never connects the map; storage that throws remembers nothing; and the
// Connect form's link carries the chosen relay and nothing else.

import { describe, expect, it } from 'vitest';
import { CHOICE_KEY_PREFIX as BOARD_PREFIX } from '../../demo/src/connect.ts';
import {
  CHOICE_KEY_PREFIX,
  type ChoiceStore,
  choiceKey,
  connectHref,
  LINK_HINT_MS,
  linkStatus,
  rememberChoice,
  wasChosen,
} from './connect.ts';

const RELAY = 'wss://relay.example/page';

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

describe("the map demo's remembered choice", () => {
  it('remembers exactly the relay URL chosen, under its own prefix', () => {
    const store = memoryStore();
    expect(wasChosen(store, RELAY)).toBe(false);
    rememberChoice(store, RELAY);
    expect(wasChosen(store, RELAY)).toBe(true);
    expect([...store.entries.keys()]).toEqual([`tabdock-map-demo:connect:${RELAY}`]);
    for (const other of ['wss://relay.example/page2', 'ws://relay.example/page']) {
      expect(wasChosen(store, other)).toBe(false);
    }
  });

  it("is never the board's choice: neither prefix starts the other", () => {
    expect(CHOICE_KEY_PREFIX.startsWith(BOARD_PREFIX)).toBe(false);
    expect(BOARD_PREFIX.startsWith(CHOICE_KEY_PREFIX)).toBe(false);
    const store = memoryStore();
    store.setItem(`${BOARD_PREFIX}${RELAY}`, '1');
    expect(wasChosen(store, RELAY)).toBe(false);
    expect(choiceKey(RELAY).startsWith('tabdock:')).toBe(false);
  });

  it('remembers nothing where storage throws or is missing', () => {
    const throwing: ChoiceStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    rememberChoice(throwing, RELAY);
    expect(wasChosen(throwing, RELAY)).toBe(false);
    rememberChoice(null, RELAY);
    expect(wasChosen(null, RELAY)).toBe(false);
  });

  it("goes to ?relay= with the chosen relay alone, dropping the page's other parameters and hash", () => {
    expect(connectHref('https://site.example/map/?invites=all&relay=ws://x/page#top', RELAY)).toBe(
      `https://site.example/map/?relay=${encodeURIComponent(RELAY)}`,
    );
  });
});

describe("the map demo's status line once a relay is chosen", () => {
  const registered = '14 tools registered';
  const origin = 'https://demo.example';

  it('names the relay and its link, and after a while unlinked, what to check', () => {
    expect(linkStatus(registered, 'relay.example', 'linked', false, origin)).toBe(
      '14 tools registered; Tabdock relay relay.example: linked',
    );
    expect(linkStatus(registered, '127.0.0.1:9', 'reconnecting', false, origin)).toBe(
      '14 tools registered; Tabdock relay 127.0.0.1:9: reconnecting',
    );
    expect(linkStatus(registered, '127.0.0.1:9', 'reconnecting', true, origin)).toBe(
      '14 tools registered; Tabdock relay 127.0.0.1:9: reconnecting; still not linked: check that the relay is running and lists https://demo.example in TABDOCK_ALLOWED_ORIGINS',
    );
    expect(LINK_HINT_MS).toBe(10_000);
  });
});
