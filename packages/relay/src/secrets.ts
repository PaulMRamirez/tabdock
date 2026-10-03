// Identifiers, pairing codes and resume tokens, all from node:crypto randomness.
// Secrets are stored only as SHA-256 digests and compared with timingSafeEqual,
// so neither a memory dump nor a timing probe gives back a usable value (S3, S11).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped survives. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 symbols of 5 bits each: 50 bits, above S3's floor of 40. */
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_CODE_BITS = PAIRING_CODE_LENGTH * 5;

const ID_LENGTH = 10;
const RESUME_TOKEN_BYTES = 32;
/** S11 and ADR 0016: QR nonces, and invite secrets from M4, carry 128 bits. */
export const SINGLE_USE_SECRET_BYTES = 16;
const SESSION_SECRET_BYTES = 32;

/** Pages, attach requests, calls, QR claims, and the trace ids that follow one QR pairing in the logs. */
export type IdPrefix = 'pg' | 'rq' | 'cl' | 'qc' | 'tr';

/** Each byte's low 5 bits pick a symbol; 256 is a multiple of 32, so there is no bias. */
export function randomCrockford(length: number): string {
  let out = '';
  for (const byte of randomBytes(length)) out += CROCKFORD_ALPHABET.charAt(byte & 31);
  return out;
}

/** Page, request and call ids. Random, but S13 never relies on that. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomCrockford(ID_LENGTH)}`;
}

/** A fresh pairing code in normalised form (10 symbols, no separator). */
export function newPairingCode(): string {
  return randomCrockford(PAIRING_CODE_LENGTH);
}

/** How the page shows a code: XXXXX-XXXXX. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Undoes what people do to a code when they retype it: lower case, spaces,
 * hyphens, and the letters Crockford folds into digits. Anything that is still
 * not 10 symbols of the alphabet is no code at all.
 */
export function normalisePairingCode(input: string): string | null {
  if (input.length > 64) return null;
  const folded = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (folded.length !== PAIRING_CODE_LENGTH) return null;
  for (const symbol of folded) {
    if (!CROCKFORD_ALPHABET.includes(symbol)) return null;
  }
  return folded;
}

export function newResumeToken(): string {
  return randomBytes(RESUME_TOKEN_BYTES).toString('base64url');
}

/**
 * A secret for a single-use ticket (store.ts): 128 random bits as 22
 * base64url characters, short enough for a QR code a phone reads at a glance.
 */
export function newSingleUseSecret(): string {
  return randomBytes(SINGLE_USE_SECRET_BYTES).toString('base64url');
}

/** What a single-use secret looks like on the wire, so anything else is refused before a lookup. */
export const SINGLE_USE_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The value of a browser session cookie at /pair: 256 random bits, stored only as a digest. */
export function newSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString('base64url');
}

export function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function digestHex(secret: string): string {
  return digest(secret).toString('hex');
}

/** Constant-time equality for two digests; digests always have equal length. */
export function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
