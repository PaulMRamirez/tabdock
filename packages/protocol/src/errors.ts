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
  'invalid_arguments',
  // From M4: an invitee offered a pairing code, which only members may use (ADR 0017).
  'invite_required',
  // From M5: a confirmation in the caller's client that was declined, dismissed,
  // expired, reused, forged or given for other arguments; the page never hears
  // of such a call (ADR 0026).
  'not_confirmed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * How a Tabdock error reads inside an MCP tool error. The code comes first so a
 * client (or a test) can match it without parsing prose.
 */
export function formatError(code: ErrorCode, message: string): string {
  return `${code}: ${message}`;
}

/** The first line of every page result (SPEC.md section 7, S10). */
export function untrustedHeader(origin: string, tool: string): string {
  return `[tabdock: untrusted content from ${origin}, tool ${tool}]`;
}

/** Cuts text to `max` characters and says so, so nobody mistakes a cut result for a whole one. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n[tabdock: truncated, ${String(text.length - max)} of ${String(text.length)} characters removed]`,
    truncated: true,
  };
}
