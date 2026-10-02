import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  digest,
  formatPairingCode,
  newId,
  newPairingCode,
  newResumeToken,
  normalisePairingCode,
  PAIRING_CODE_BITS,
  sameDigest,
} from '../src/secrets.ts';

const SYMBOL = `[${CROCKFORD_ALPHABET}]`;

describe('pairing codes (S3)', () => {
  it('carry 50 bits from a 32-symbol alphabet with no I, L, O or U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
    expect(PAIRING_CODE_BITS).toBe(50);
    expect(PAIRING_CODE_BITS).toBeGreaterThanOrEqual(40);
  });

  it('are 10 symbols, shown as XXXXX-XXXXX', () => {
    const code = newPairingCode();
    expect(code).toMatch(new RegExp(`^${SYMBOL}{10}$`));
    expect(formatPairingCode(code)).toMatch(new RegExp(`^${SYMBOL}{5}-${SYMBOL}{5}$`));
    expect(formatPairingCode(code).replace('-', '')).toBe(code);
  });

  it('look uniformly random: no repeats, every symbol used about equally', () => {
    const codes = Array.from({ length: 4000 }, () => newPairingCode());
    expect(new Set(codes).size).toBe(codes.length);
    const counts = new Map<string, number>();
    for (const symbol of codes.join('')) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    expect(counts.size).toBe(32);
    // 40,000 symbols over 32 buckets: 1250 each on average. A biased generator
    // (modulo bias, a stuck bit) lands far outside this band.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1050);
      expect(count).toBeLessThan(1450);
    }
  });

  it('normalise what people type: case, spaces, hyphens, O to 0, I and L to 1', () => {
    expect(normalisePairingCode('ABCDE-FGH12')).toBe('ABCDEFGH12');
    expect(normalisePairingCode(' abcde fgh12 ')).toBe('ABCDEFGH12');
    expect(normalisePairingCode('a-b-c-d-e-f-g-h-1-2')).toBe('ABCDEFGH12');
    expect(normalisePairingCode('OoIiLl0123')).toBe('0011110123');
    expect(normalisePairingCode('ABCDE\tFGH12')).toBe('ABCDEFGH12');
  });

  it('reject anything that is not then 10 alphabet symbols', () => {
    for (const input of [
      '',
      'ABCDE',
      'ABCDE-FGH123',
      'ABCDE-FGHU2',
      'ABCDE-FGH1!',
      'ABCDÉ-FGH12',
      'x'.repeat(65),
      `${'A'.repeat(10)}${' '.repeat(60)}`,
    ]) {
      expect(normalisePairingCode(input), input).toBeNull();
    }
  });
});

describe('identifiers and tokens', () => {
  it('prefix 10 Crockford symbols', () => {
    expect(newId('pg')).toMatch(new RegExp(`^pg_${SYMBOL}{10}$`));
    expect(newId('rq')).toMatch(new RegExp(`^rq_${SYMBOL}{10}$`));
    expect(newId('cl')).toMatch(new RegExp(`^cl_${SYMBOL}{10}$`));
    const ids = new Set(Array.from({ length: 1000 }, () => newId('pg')));
    expect(ids.size).toBe(1000);
  });

  it('resume tokens carry 256 bits, base64url', () => {
    const token = newResumeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newResumeToken()).not.toBe(token);
  });

  it('digests compare equal only for equal secrets', () => {
    expect(sameDigest(digest('abc'), digest('abc'))).toBe(true);
    expect(sameDigest(digest('abc'), digest('abd'))).toBe(false);
    expect(sameDigest(digest('abc'), Buffer.alloc(3))).toBe(false);
  });
});
