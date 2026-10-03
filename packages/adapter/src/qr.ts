// The pairing URL as a QR code beside the typed code (docs/plans/M3.md,
// Widget QR). The URL carries a single-use nonce in its fragment (S11), so it
// is never logged and never shown as text: it appears only as this drawing,
// inside the widget's closed shadow root.
//
// Drawn from the library's isDark() matrix with createElementNS and
// setAttribute alone. The library's own SVG string needs innerHTML and its
// image needs a data: URL, and pages under Trusted Types or a strict img-src
// block both (docs/notes/m3/tunnel-qr-spike.md, section 2); the adapter runs on
// pages whose CSP it does not control, and no relay- or page-supplied string
// ever goes through an HTML parser here.

import qrcode from 'qrcode-generator';

/** The QR spec's quiet zone: four light modules on every side, which scanners need to find the code. */
export const QR_QUIET_ZONE = 4;

/**
 * The relay's URL is its public origin, /pair# and a 22-character nonce:
 * about 70 characters, QR version 4 to 6 at level M. 256 leaves room for a
 * long hostname and still stays at version 12 or below (65 modules), which a
 * phone reads from the widget's square on a laptop screen. Anything longer is
 * not what the relay builds.
 */
export const MAX_QR_URL_LENGTH = 256;

/**
 * The drawing's side in CSS pixels, quiet zone included: 2.5 to 3 px a module
 * at the usual versions 4 to 6, which a phone reads from a laptop screen.
 */
export const QR_SIDE_PX = 124;

/**
 * Printable ASCII and nothing else: the library keeps only the low byte of
 * each character, so anything wider would encode a different URL, and
 * whitespace or controls have no place in one the relay built.
 */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

const SVG_NS = 'http://www.w3.org/2000/svg';

type QrCode = ReturnType<typeof qrcode>;

/**
 * The nonce in the fragment, as the relay draws it (secrets.ts,
 * newSingleUseSecret): 128 bits as 22 base64url characters, no padding.
 */
const PAIRING_FRAGMENT = /^#[A-Za-z0-9_-]{22}$/;

/**
 * The URL the widget may draw, or null. The relay builds it from its public
 * URL, which must be https (ADR 0014), so anything else is a misconfigured or
 * misbehaving relay, and a phone should never be sent there: no code is drawn
 * and the typed code still works.
 *
 * Only the shape the relay builds passes, `<origin>/pair#<nonce>`, spelled
 * exactly as the parser spells it back: that shape rebuilt from the parsed
 * origin and fragment must equal the text. The drawn text is what a scanner
 * shows and opens, so it must be the text that was checked; a backslash or
 * `https:host` makes one string read as one host and parse as another, and
 * credentials only serve to dress one host up as another. The same equality
 * refuses any other path, any query (even an empty one) and any other spelling.
 */
export function pairingQrUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > MAX_QR_URL_LENGTH || !PRINTABLE_ASCII.test(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !PAIRING_FRAGMENT.test(parsed.hash)) return null;
  return value === `${parsed.origin}/pair${parsed.hash}` ? value : null;
}

/** The library's code for text at error correction level M, or null if it will not encode. */
export function encodeQr(text: string): QrCode | null {
  try {
    const code = qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();
    return code;
  } catch {
    return null;
  }
}

export interface QrPath {
  /** Modules across, quiet zone included: the side of the viewBox. */
  readonly size: number;
  /** One subpath per horizontal run of dark modules, a rectangle one module tall. */
  readonly d: string;
}

/** The SVG path for a pairing URL, or null when the URL is refused (see pairingQrUrl). */
export function qrPath(url: string | undefined): QrPath | null {
  const text = pairingQrUrl(url);
  const code = text === null ? null : encodeQr(text);
  if (code === null) return null;
  const count = code.getModuleCount();
  // Runs rather than single modules keep the path a few kilobytes at most.
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!code.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && code.isDark(row, col)) col += 1;
      const run = col - start;
      parts.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${run}v1h-${run}z`);
    }
  }
  return { size: count + 2 * QR_QUIET_ZONE, d: parts.join('') };
}

export interface QrView {
  readonly element: SVGSVGElement;
  /**
   * Draws the URL, or clears the drawing when the URL is absent or refused,
   * and returns whether a code is on show. Cheap to call on every render: only
   * a different URL is drawn again.
   */
  show(url: string | undefined): boolean;
}

export function createQrView(doc: Document): QrView {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  // Whole modules on whole pixels where the scale allows; blurred edges cost scanners.
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing QR code: scan it with a phone to pair');
  // The drawing carries its own size and light ground as attributes, which no
  // style-src governs: a page whose CSP refuses the widget's stylesheet must
  // not leave dark modules on its own dark background, stretched across it.
  svg.setAttribute('width', String(QR_SIDE_PX));
  svg.setAttribute('height', String(QR_SIDE_PX));
  // Behind the modules, over the whole viewBox, quiet zone included.
  const ground = doc.createElementNS(SVG_NS, 'rect');
  ground.setAttribute('width', '100%');
  ground.setAttribute('height', '100%');
  const path = doc.createElementNS(SVG_NS, 'path');
  // Fixed colours, as a scanner needs dark on light whatever the page's theme.
  ground.setAttribute('fill', '#fff');
  path.setAttribute('fill', '#000');
  svg.append(ground, path);

  let drawn: string | undefined;
  let showing = false;
  return {
    element: svg,
    show(url) {
      if (url === drawn) return showing;
      drawn = url;
      const next = qrPath(url);
      showing = next !== null;
      if (next === null) {
        // Nothing of an old or refused URL stays in the tree.
        path.removeAttribute('d');
        svg.removeAttribute('viewBox');
      } else {
        svg.setAttribute('viewBox', `0 0 ${next.size} ${next.size}`);
        path.setAttribute('d', next.d);
      }
      return showing;
    },
  };
}
