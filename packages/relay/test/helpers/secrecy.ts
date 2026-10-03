// The secrecy scan for local mode's tests (ADR 0022): whether some text holds
// an owner token, its digest in any encoding the relay could print, or any
// 8-character run of its 43 random characters. It says which form it found,
// never the form itself, so a failing test does not print the secret either.

import { createHash } from 'node:crypto';

const PREFIX = 'tabdock_';
const RUN = 8;

export function leakIn(text: string, token: string): string | null {
  const random = token.startsWith(PREFIX) ? token.slice(PREFIX.length) : token;
  const digest = createHash('sha256').update(token, 'utf8').digest();
  const hex = digest.toString('hex');
  if (text.includes(token)) return 'the token';
  if (text.toLowerCase().includes(hex)) return 'its digest in hex';
  if (text.includes(digest.toString('base64'))) return 'its digest in base64';
  if (text.includes(digest.toString('base64url'))) return 'its digest in base64url';
  for (let offset = 0; offset + RUN <= random.length; offset += 1) {
    if (text.includes(random.slice(offset, offset + RUN))) {
      return `an ${String(RUN)}-character run of its random part, at offset ${String(offset)}`;
    }
  }
  return null;
}
