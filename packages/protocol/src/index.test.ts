import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  isErrorCode,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  SUBPROTOCOL,
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
