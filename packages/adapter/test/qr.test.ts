import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { createQrView, MAX_QR_URL_LENGTH, pairingQrUrl, qrPath } from '../src/qr.ts';

// Shaped like the relay's: its public URL, /pair#, and a 22-character base64url nonce.
const SAMPLE_URL = 'https://tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA';
const OTHER_URL = 'https://tabdock-owner.ngrok-free.app/pair#Vb7nQ1sX_e4Jk0LmZp9RtA';
/** Written out rather than imported: four modules is the QR spec's minimum, not a setting. */
const QUIET_ZONE = 4;

/** The dark modules the library puts at (row, col), shifted by the quiet zone, and the side with it. */
function libraryModules(text: string, level: 'L' | 'M' = 'M'): { size: number; dark: Set<string> } {
  const code = qrcode(0, level);
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const dark = new Set<string>();
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) dark.add(`${row + QUIET_ZONE},${col + QUIET_ZONE}`);
    }
  }
  return { size: count + 2 * QUIET_ZONE, dark };
}

/**
 * Reads the modules back out of the path, which must be nothing but
 * one-module-tall runs, so any other drawing (or any text) fails here.
 */
function pathModules(d: string): Set<string> {
  const run = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/gy;
  const dark = new Set<string>();
  let end = 0;
  for (let match = run.exec(d); match !== null; match = run.exec(d)) {
    const [, x, y, width, back] = match.map(Number);
    if (x === undefined || y === undefined || width === undefined || width !== back) {
      throw new Error(`a run that does not close: ${match[0]}`);
    }
    for (let col = x; col < x + width; col += 1) dark.add(`${y},${col}`);
    end = run.lastIndex;
  }
  if (end !== d.length) throw new Error(`the path has more than runs from offset ${end}`);
  return dark;
}

describe('qrPath', () => {
  it("draws exactly the library's level M matrix inside a four-module quiet zone", () => {
    const path = qrPath(SAMPLE_URL);
    expect(path).not.toBeNull();
    const expected = libraryModules(SAMPLE_URL);
    expect(path?.size).toBe(expected.size);
    const drawn = pathModules(path?.d ?? '');
    expect(drawn).toEqual(expected.dark);
    // Nothing in the quiet zone.
    const inner = (n: number) => n >= QUIET_ZONE && n < expected.size - QUIET_ZONE;
    for (const cell of drawn) {
      const [row = -1, col = -1] = cell.split(',').map(Number);
      expect(inner(row) && inner(col)).toBe(true);
    }
    // The level is part of the matrix (its format bits), so another level draws something else.
    expect(drawn).not.toEqual(libraryModules(SAMPLE_URL, 'L').dark);
  });

  it('draws a different code for each URL', () => {
    const one = qrPath(SAMPLE_URL);
    const other = qrPath(OTHER_URL);
    expect(other?.d).not.toBe(one?.d);
    expect(pathModules(other?.d ?? '')).toEqual(libraryModules(OTHER_URL).dark);
  });

  it('draws nothing for a URL that is not https', () => {
    for (const url of [
      'http://tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      'javascript:alert(1)//https://tabdock-owner.ngrok-free.app/',
      'data:text/html,<h1>pair</h1>',
      'wss://tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      'ftp://tabdock-owner.ngrok-free.app/pair',
      '//tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      '/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      'https://',
      '',
    ]) {
      expect(pairingQrUrl(url), url).toBeNull();
      expect(qrPath(url), url).toBeNull();
    }
    expect(qrPath(undefined)).toBeNull();
  });

  it('draws nothing for a URL with credentials, spaces or characters the library would mangle', () => {
    for (const url of [
      'https://tabdock-owner.ngrok-free.app@evil.example/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      'https://user:secret@tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
      'https://tabdock-owner.ngrok-free.app/pair #q3Zf0_Wn-8xLr2TmB9cKpA',
      'https://tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA\n',
      'https://tåbdock.example/pair#q3Zf0_Wn-8xLr2TmB9cKpA',
    ]) {
      expect(qrPath(url), url).toBeNull();
    }
  });

  it(`draws a URL of up to ${MAX_QR_URL_LENGTH} characters and nothing longer`, () => {
    const base = 'https://tabdock-owner.ngrok-free.app/pair#';
    const longest = base + 'a'.repeat(MAX_QR_URL_LENGTH - base.length);
    expect(longest).toHaveLength(MAX_QR_URL_LENGTH);
    const path = qrPath(longest);
    expect(pathModules(path?.d ?? '')).toEqual(libraryModules(longest).dark);
    expect(qrPath(`${longest}a`)).toBeNull();
    expect(qrPath(base + 'a'.repeat(2048))).toBeNull();
  });
});

// A stand-in for the few DOM calls the view makes. Any HTML-parsing sink throws,
// as it would on a page that enforces Trusted Types.
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly namespaceURI: string;
  readonly localName: string;
  constructor(namespaceURI: string, localName: string) {
    this.namespaceURI = namespaceURI;
    this.localName = localName;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  set innerHTML(_value: string) {
    throw new TypeError("This document requires 'TrustedHTML' assignment.");
  }
  insertAdjacentHTML(): void {
    throw new TypeError("This document requires 'TrustedHTML' assignment.");
  }
}

function fakeDocument(): { doc: Document; created: FakeElement[] } {
  const created: FakeElement[] = [];
  const doc = {
    createElementNS(namespace: string, name: string) {
      const node = new FakeElement(namespace, name);
      created.push(node);
      return node;
    },
  };
  return { doc: doc as unknown as Document, created };
}

describe('createQrView', () => {
  it('builds one SVG path with DOM calls, redraws for a new URL and clears without one', () => {
    const { doc, created } = fakeDocument();
    const view = createQrView(doc);
    const svg = view.element as unknown as FakeElement;
    expect(created.map((node) => [node.namespaceURI, node.localName])).toEqual([
      ['http://www.w3.org/2000/svg', 'svg'],
      ['http://www.w3.org/2000/svg', 'path'],
    ]);
    expect(svg.children.map((node) => node.localName)).toEqual(['path']);
    const path = svg.children[0];

    expect(view.show(SAMPLE_URL)).toBe(true);
    const first = libraryModules(SAMPLE_URL);
    expect(svg.attributes.get('viewBox')).toBe(`0 0 ${first.size} ${first.size}`);
    expect(pathModules(path?.attributes.get('d') ?? '')).toEqual(first.dark);
    // The same URL again, as every render passes it, changes nothing.
    expect(view.show(SAMPLE_URL)).toBe(true);

    expect(view.show(OTHER_URL)).toBe(true);
    expect(pathModules(path?.attributes.get('d') ?? '')).toEqual(libraryModules(OTHER_URL).dark);

    expect(view.show(undefined)).toBe(false);
    expect(path?.attributes.has('d')).toBe(false);
    expect(svg.attributes.has('viewBox')).toBe(false);

    expect(view.show(SAMPLE_URL)).toBe(true);
    expect(view.show('http://tabdock-owner.ngrok-free.app/pair#q3Zf0_Wn-8xLr2TmB9cKpA')).toBe(
      false,
    );
    expect(path?.attributes.has('d')).toBe(false);
    // Only the two elements made at the start, ever.
    expect(created).toHaveLength(2);
  });
});
