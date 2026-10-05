// What an /mcp request holds on the heap while the relay keeps it waiting on
// a page (S9, ADR 0018's notes). A call waits for the page to answer, up to
// its deadline, and a pairing for the operator; all the while its request
// keeps its body and the value parsed from it. The request budget bounds how
// many such requests a user makes in a minute, not what they hold: one member
// held 237 MiB with 120 calls of 1 MB, and a body of empty objects holds about
// twenty times its size once parsed. So relay.ts measures each body here, from
// its bytes, without parsing it, and the hub charges the result against what
// waiting requests may hold (limits.requestBytes and requestBytesPerUser).

/**
 * What every waiting request holds besides its body: the SDK's request,
 * stream and server objects (a whole server per request on the 2026-07-28
 * leg), and the relay's record of the call. A waiting call with an almost
 * empty body held 62 KiB on the 2025-era leg and 121 KiB on the 2026-07-28
 * leg in call-heap.test.ts; twice the larger leaves room for what a client
 * names itself and the noise of measuring.
 */
export const REQUEST_HEAP_BYTES = 256 * 1024;
/** A value's slot in its array or at the root, and the box a number may need. */
export const VALUE_HEAP_BYTES = 32;
/** An object or an array: its header, its hidden class and its backing store's own header. */
export const CONTAINER_HEAP_BYTES = 128;
/** A string's header beside its characters, a key's included. */
export const STRING_HEAP_BYTES = 64;
/**
 * An object's property: its entry in a dictionary at the lowest load V8
 * keeps, twice over, since the SDK's and the relay's schemas each copy the
 * outer keys of what they check, and the box its value may need.
 */
export const PROPERTY_HEAP_BYTES = 128;
/**
 * More for a property whose key is digits alone: V8 keeps such keys as
 * elements, and sparse ones, past an index as high as 4294967294, as a
 * dictionary of their own, which held 1.12 of the charge without this on the
 * 2026-07-28 leg and 0.74 with it (call-heap.test.ts, ADR 0030).
 */
export const INDEX_KEY_HEAP_BYTES = 128;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const OPEN_OBJECT = 0x7b;
const COMMA = 0x2c;
const COLON = 0x3a;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const NON_ASCII = 0x80;

/**
 * What a request with this JSON body is measured to hold on the heap while
 * it lives, set above what every shape in call-shapes.ts was measured to hold
 * on both legs; a charge counted from bytes can be shown to cover the shapes
 * tried, never every shape (ADR 0030). It is REQUEST_HEAP_BYTES; the body
 * itself as one string, which the SDK's Node adapter keeps in the web Request
 * it builds, at one byte a character when every byte is ASCII and two a byte
 * otherwise; and the value parsed from it, counted from the bytes alone,
 * token by token, without parsing: the root value's slot, each '{' an object,
 * each '[' an array and its first value's slot, each ',' the next value's
 * slot, each ':' a property, and INDEX_KEY_HEAP_BYTES more when its key is
 * digits alone, and each string, a key or a value, its header and two bytes
 * for each byte inside it, since a parsed string holds at most one UTF-16
 * unit for each byte it took on the wire. Each cost sits above what
 * JSON.parse was measured to hold for it under --expose-gc on Node 22 (an
 * empty object 64 bytes, an empty array 40, a number in an array 8, a
 * property of a dictionary-mode object about 50), and call-heap.test.ts
 * checks the whole against the heap a waiting call holds in the relay, for
 * bodies of every shape that holds the most. A body that is not JSON is
 * charged the same way, which only ever overstates it.
 */
export function requestHeapBytes(body: Uint8Array): number {
  let parsed = VALUE_HEAP_BYTES;
  let stringBytes = 0;
  let ascii = true;
  let inString = false;
  // Whether the string being read has been digits alone so far, and whether
  // the last one closed was, so the colon after it makes an index key.
  let digits = false;
  let indexKey = false;
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index] ?? 0;
    if (byte >= NON_ASCII) ascii = false;
    if (inString) {
      if (byte === QUOTE) {
        inString = false;
        // An empty key is no index, and neither is one ending in an escaped quote.
        indexKey = digits && body[index - 1] !== QUOTE;
      } else if (byte === BACKSLASH) {
        // The escaped byte cannot end the string; both are counted, which
        // overstates it. An escape such as \u0031 may stand for a digit, so it
        // leaves `digits` as it was, which can only overstate too.
        index += 1;
        stringBytes += 2;
        if ((body[index] ?? 0) >= NON_ASCII) ascii = false;
      } else {
        stringBytes += 1;
        if (byte < DIGIT_ZERO || byte > DIGIT_NINE) digits = false;
      }
      continue;
    }
    switch (byte) {
      case QUOTE:
        inString = true;
        digits = true;
        parsed += STRING_HEAP_BYTES;
        break;
      case OPEN_OBJECT:
        parsed += CONTAINER_HEAP_BYTES;
        break;
      case OPEN_ARRAY:
        parsed += CONTAINER_HEAP_BYTES + VALUE_HEAP_BYTES;
        break;
      case COMMA:
        parsed += VALUE_HEAP_BYTES;
        break;
      case COLON:
        parsed += PROPERTY_HEAP_BYTES + (indexKey ? INDEX_KEY_HEAP_BYTES : 0);
        indexKey = false;
        break;
      default:
        break;
    }
  }
  return REQUEST_HEAP_BYTES + (ascii ? 1 : 2) * body.length + parsed + 2 * stringBytes;
}
