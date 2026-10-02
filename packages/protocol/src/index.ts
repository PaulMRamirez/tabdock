// Constants fixed by SPEC.md section 6. The frame schemas themselves arrive in M1;
// these live here now so the relay and adapter can never disagree on them.

/** WebSocket subprotocol for the page link. */
export const SUBPROTOCOL = 'tabdock.v1';

/** Largest page link frame either side accepts, in bytes. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Tool results longer than this many characters are truncated with a visible marker. */
export const MAX_RESULT_CHARS = 120_000;

/** Error codes the relay returns to MCP clients (SPEC.md section 7). */
export const ERROR_CODES = [
  'not_attached',
  'role_denied',
  'tool_not_found',
  'page_asleep',
  'page_gone',
  'denied_by_operator',
  'timeout',
  'page_busy',
  'pairing_expired',
  'rate_limited',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
