import { describe, expect, it } from 'vitest';
import {
  CHOICE_KEY_PREFIX,
  type ChoiceStore,
  choiceKey,
  connectHref,
  rememberChoice,
  wasChosen,
} from './connect.ts';
import { DEFAULT_LINK_POLICY, linkPolicyFromQuery, policyTag } from './policy.ts';

const RELAY = 'wss://relay.example/page';
/** The tag of ?confirm=client&invites=all, the loosest a link can ask for. */
const LOOSE = policyTag({ confirmInClient: true, invites: 'all' });

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
    expect(wasChosen(store, RELAY, '')).toBe(false);
    rememberChoice(store, RELAY, '');
    expect(wasChosen(store, RELAY, '')).toBe(true);
    for (const other of [
      'wss://relay.example/page2',
      'wss://relay.example:444/page',
      'ws://relay.example/page',
      'wss://evil.example/page',
    ]) {
      expect(wasChosen(store, other, ''), other).toBe(false);
    }
  });

  it('remembers the page policy with it, so a link that changes the policy asks again', () => {
    const store = memoryStore();
    rememberChoice(store, RELAY, '');
    for (const tag of [LOOSE, 'confirm=client', 'invites=all', 'invites=off']) {
      expect(wasChosen(store, RELAY, tag), tag).toBe(false);
    }
    rememberChoice(store, RELAY, LOOSE);
    expect(wasChosen(store, RELAY, LOOSE)).toBe(true);
    expect(wasChosen(store, RELAY, 'confirm=client')).toBe(false);
    // The tag is read strictly, in one order, so spellings that set nothing are the defaults.
    for (const query of [
      '',
      '?confirm=CLIENT',
      '?invites=everyone',
      '?confirm=page&invites=watch',
    ]) {
      expect(policyTag(linkPolicyFromQuery(new URLSearchParams(query))), query).toBe('');
    }
    expect(policyTag(linkPolicyFromQuery(new URLSearchParams('?invites=all&confirm=client')))).toBe(
      LOOSE,
    );
    // No relay URL and tag can pose as another's: a parsed href never holds a space.
    expect(choiceKey(RELAY, LOOSE)).toBe(
      `tabdock-demo:connect:${RELAY} confirm=client&invites=all`,
    );
    expect(new URL('wss://relay.example/page x').href).not.toContain(' ');
  });

  it("keeps its records under a prefix of the demo's own, apart from the adapter's tabdock: keys", () => {
    const store = memoryStore();
    rememberChoice(store, RELAY, '');
    expect([...store.entries]).toEqual([['tabdock-demo:connect:wss://relay.example/page', '1']]);
    expect(choiceKey('x', '').startsWith(CHOICE_KEY_PREFIX)).toBe(true);
    expect(choiceKey('x', LOOSE).startsWith(CHOICE_KEY_PREFIX)).toBe(true);
    expect(CHOICE_KEY_PREFIX.startsWith('tabdock:')).toBe(false);
  });

  it('remembers nothing, and so asks again, where storage is missing or throws', () => {
    expect(wasChosen(null, RELAY, '')).toBe(false);
    rememberChoice(null, RELAY, '');
    const refusing: ChoiceStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => {
      rememberChoice(refusing, RELAY, '');
    }).not.toThrow();
    expect(wasChosen(refusing, RELAY, '')).toBe(false);
  });

  it('only a stored "1" counts as a choice', () => {
    const store = memoryStore();
    store.entries.set(choiceKey(RELAY, ''), 'true');
    expect(wasChosen(store, RELAY, '')).toBe(false);
  });
});

describe('connectHref, where the Connect form goes', () => {
  it("sets ?relay and keeps the page's parameters that set no policy, dropping any hash", () => {
    expect(connectHref('https://board.example/?busy=5&e2e#x', RELAY, DEFAULT_LINK_POLICY)).toBe(
      'https://board.example/?busy=5&e2e=&relay=wss%3A%2F%2Frelay.example%2Fpage',
    );
    expect(
      connectHref(
        'http://127.0.0.1:5173/?relay=ws://old/page',
        'ws://127.0.0.1:8787/page',
        DEFAULT_LINK_POLICY,
      ),
    ).toBe('http://127.0.0.1:5173/?relay=ws%3A%2F%2F127.0.0.1%3A8787%2Fpage');
  });

  it('carries ?confirm and ?invites only as the visitor ticked them, whatever the page had', () => {
    const page = 'https://board.example/?invites=all&confirm=client&invites=off';
    expect(connectHref(page, RELAY, DEFAULT_LINK_POLICY)).toBe(
      'https://board.example/?relay=wss%3A%2F%2Frelay.example%2Fpage',
    );
    expect(connectHref(page, RELAY, { confirmInClient: true, invites: 'watch' })).toBe(
      'https://board.example/?relay=wss%3A%2F%2Frelay.example%2Fpage&confirm=client',
    );
    expect(
      connectHref('https://board.example/', RELAY, { confirmInClient: true, invites: 'all' }),
    ).toBe(
      'https://board.example/?relay=wss%3A%2F%2Frelay.example%2Fpage&confirm=client&invites=all',
    );
  });

  it('keeps a subpath, so a copy under <user>.github.io/<repository>/ stays where it is', () => {
    expect(connectHref('https://user.github.io/tabdock/', RELAY, DEFAULT_LINK_POLICY)).toBe(
      'https://user.github.io/tabdock/?relay=wss%3A%2F%2Frelay.example%2Fpage',
    );
  });
});
