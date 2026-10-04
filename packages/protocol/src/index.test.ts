import { describe, expect, it } from 'vitest';
import {
  ATTACH_REQUEST_TTL_MS,
  CLOSE_DETACH,
  CLOSE_INVALID_FRAME_PAGE,
  CLOSE_REPLACED,
  CLOSE_SILENT,
  ERROR_CODES,
  formatError,
  isErrorCode,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  IDLE_TIMEOUT_MS,
  PAIR_WAIT_MS,
  PAIRING_TTL_MS,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
  SUBPROTOCOL,
  truncate,
  untrustedHeader,
} from './index.ts';

describe('protocol constants', () => {
  it('match SPEC.md section 6', () => {
    expect(SUBPROTOCOL).toBe('tabdock.v1');
    expect(MAX_FRAME_BYTES).toBe(1_048_576);
    expect(MAX_RESULT_CHARS).toBe(120_000);
  });

  // Literal values, so a change to a security timing fails here rather than slipping through.
  it('match SPEC.md sections 5, 6 and 9 and ADR 0005', () => {
    expect(PAIRING_TTL_MS).toBe(120_000);
    expect(ATTACH_REQUEST_TTL_MS).toBe(60_000);
    expect(PAIR_WAIT_MS).toBe(50_000);
    // Under Claude Code's 60 s first-byte limit, and inside the request's own lifetime.
    expect(PAIR_WAIT_MS).toBeLessThan(60_000);
    expect(PAIR_WAIT_MS).toBeLessThan(ATTACH_REQUEST_TTL_MS);
    expect(RESUME_WINDOW_MS).toBe(600_000);
    expect(PING_INTERVAL_MS).toBe(15_000);
    expect(IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('keep page-link close codes distinct and in the range page code may send', () => {
    const codes = [CLOSE_DETACH, CLOSE_REPLACED, CLOSE_SILENT, CLOSE_INVALID_FRAME_PAGE];
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code >= 3000 && code <= 4999).toBe(true);
  });

  it('recognise exactly the error codes from SPEC.md section 7, invite_required included from M4', () => {
    expect(ERROR_CODES).toHaveLength(12);
    expect(new Set(ERROR_CODES).size).toBe(12);
    expect(isErrorCode('page_gone')).toBe(true);
    expect(isErrorCode('invite_required')).toBe(true);
    expect(isErrorCode('PAGE_GONE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });
});

describe('result helpers', () => {
  it('formats errors code first', () => {
    expect(formatError('not_attached', 'no such page')).toBe('not_attached: no such page');
  });

  it('labels page content with its origin and tool', () => {
    expect(untrustedHeader('http://127.0.0.1:5173', 'get_view')).toBe(
      '[tabdock: untrusted content from http://127.0.0.1:5173, tool get_view]',
    );
  });

  it('truncates with a visible marker and leaves short text alone', () => {
    expect(truncate('short', 10)).toEqual({ text: 'short', truncated: false });
    const cut = truncate('x'.repeat(25), 10);
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith('x'.repeat(10))).toBe(true);
    expect(cut.text).toContain('15 of 25 characters removed');
  });
});
