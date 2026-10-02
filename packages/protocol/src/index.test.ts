import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  formatError,
  isErrorCode,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
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

  it('recognise exactly the ten error codes from SPEC.md section 7', () => {
    expect(ERROR_CODES).toHaveLength(10);
    expect(new Set(ERROR_CODES).size).toBe(10);
    expect(isErrorCode('page_gone')).toBe(true);
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
