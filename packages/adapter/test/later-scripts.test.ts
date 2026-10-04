// What a page script that runs after attach() can catch of an invite secret,
// or change of what the page sends, by patching a built-in the adapter calls
// (S4, S11, S14, threat model B5). The adapter takes the built-ins it hands a
// secret or a frame's text to once, by the time attach() returns, so
// patching them later catches nothing: here String.prototype and the typed
// array length getter while a secret is drawn, JSON.parse while a
// redemption arrives, and JSON.stringify and the typed array length while
// the operator's Deny goes out. Routes it does not close (zod's checks, any
// toJSON, Map, Promise, the panel's DOM) are the residual the threat model
// records; the browser half of this, the socket and MessageEvent, is in
// tests/e2e/specs/later-scripts.spec.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { base64url } from '../src/core.ts';
import {
  attachRequest,
  flush,
  invitesFrame,
  link,
  listingOf,
  mint,
  redemption,
  setup,
  until,
} from './harness.ts';

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** Replaces a property for the rest of the test, as a later page script would. */
function patch(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  const original = Reflect.getOwnPropertyDescriptor(target, key);
  Reflect.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Reflect.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

function restoreAll(): void {
  while (restores.length > 0) restores.pop()?.();
}

/**
 * Wraps every method of String.prototype so each call's receiver, string
 * arguments and string result are recorded, and the typed array length
 * getter so every plain 16-byte Uint8Array it is asked about is copied: an
 * invite secret is 16 random bytes before it is text.
 */
function spyOnStringsAndBytes(): { strings: string[]; chars: string[]; bytes: Uint8Array[] } {
  const strings: string[] = [];
  const chars: string[] = [];
  const bytes: Uint8Array[] = [];
  let busy = false;
  const record = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
  };
  for (const key of Reflect.ownKeys(String.prototype)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(String.prototype, key);
    const original: unknown = descriptor?.value;
    if (key === 'constructor' || typeof original !== 'function') continue;
    patch(String.prototype, key, {
      writable: true,
      value: function (this: unknown, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(original, this, args);
        if (!busy) {
          busy = true;
          record(this);
          for (const arg of args) record(arg);
          record(result);
          if (typeof result === 'string' && result.length === 1) chars.push(result);
          busy = false;
        }
        return result;
      },
    });
  }
  const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
  const lengthGetter = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
  if (!lengthGetter) throw new Error('no typed array length getter');
  patch(Uint8Array.prototype, 'length', {
    get(this: Uint8Array): unknown {
      const length: unknown = Reflect.apply(lengthGetter, this, []);
      if (!busy && length === 16 && Reflect.getPrototypeOf(this) === Uint8Array.prototype) {
        busy = true;
        bytes.push(Uint8Array.prototype.slice.call(this));
        busy = false;
      }
      return length;
    },
  });
  return { strings, chars, bytes };
}

describe('a page script that runs after attach() and patches built-ins', () => {
  it('catches no new invite secret through String.prototype or the typed array length as the secret is drawn', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    await flush();

    const seen = spyOnStringsAndBytes();
    const pending = h.dock.invite({ label: 'Probe', role: 'observer', uses: 5 });
    await until(() => socket.framesOf('invite_create').length > 0, 'an invite_create frame');
    const create = socket.framesOf('invite_create')[0];
    if (!create) throw new Error('no invite_create');
    // The relay lists it, and the core builds the link and resolves with it.
    socket.deliver(invitesFrame([listingOf(create)]));
    restoreAll();

    const result = await pending;
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    const secret = result.link.slice(result.link.indexOf('#') + 1);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect(seen.strings.filter((text) => text.includes(secret))).toEqual([]);
    // One character at a time, as a table lookup would hand them over.
    expect(seen.chars.join('')).not.toContain(secret);
    // Turned back into text here, after every patch is gone.
    expect(seen.bytes.filter((copy) => base64url(copy) === secret)).toEqual([]);
  });

  it("catches no redemption's secret through JSON.parse as the relay's frame arrives", async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    const minted = await mint(h, socket, { label: 'Probe', role: 'observer', uses: 5 });

    const parsed: string[] = [];
    const original = JSON.parse;
    patch(JSON, 'parse', {
      writable: true,
      value: function (text: string, reviver?: Parameters<typeof JSON.parse>[1]): unknown {
        parsed.push(text);
        return Reflect.apply(original, JSON, [text, reviver]);
      },
    });
    socket.deliver(redemption(h.clock, minted));
    await flush();
    restoreAll();

    // The redemption arrived and was checked, with the secret it carried.
    await until(() => h.dock.state.pendingRequests.length + h.dock.state.joins.length > 0);
    expect(parsed.filter((text) => text.includes(minted.secret))).toEqual([]);
  });

  it("sees no frame the page sends through JSON.stringify or the typed array length, and cannot turn the operator's Deny into Allow there", async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(attachRequest(h.clock, 'req-x'));
    await until(() => h.dock.state.pendingRequests.length > 0, 'the prompt');

    const seen: string[] = [];
    const isFrame = (text: string): boolean => text.startsWith('{"t":');
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    patch(JSON, 'stringify', {
      writable: true,
      value: function (...args: unknown[]): unknown {
        const text: unknown = Reflect.apply(stringify, JSON, args);
        if (typeof text !== 'string' || !isFrame(text)) return text;
        seen.push(text);
        // What a script that wanted in would hand back: every answer an Allow as driver.
        const frame = parse(text) as Record<string, unknown>;
        return frame.t === 'attach_decision'
          ? Reflect.apply(stringify, JSON, [{ ...frame, allow: true, role: 'driver' }])
          : text;
      },
    });
    const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
    const lengthGetter = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
    if (!lengthGetter) throw new Error('no typed array length getter');
    const decoder = new TextDecoder();
    let busy = false;
    patch(Uint8Array.prototype, 'length', {
      get(this: Uint8Array): unknown {
        const length: unknown = Reflect.apply(lengthGetter, this, []);
        if (!busy) {
          busy = true;
          const text = decoder.decode(this);
          if (isFrame(text)) seen.push(text);
          busy = false;
        }
        return length;
      },
    });

    expect(h.dock.deny('req-x')).toBe(true);
    await flush();
    restoreAll();

    expect(
      socket.framesOf('attach_decision').filter((frame) => frame.requestId === 'req-x'),
    ).toEqual([{ t: 'attach_decision', requestId: 'req-x', allow: false }]);
    expect(seen).toEqual([]);
  });
});
