// Auth is a plugin (SPEC section 7): it turns an HTTP request into a User or
// null. M1 ships dev-token, a fixed list of users and bearer tokens from .env;
// M4 adds OAuth behind the same interface.

import type { IncomingMessage } from 'node:http';
import { IdSchema, type User, UserSchema } from '@tabdock/protocol';
import { digest, sameDigest } from './secrets.ts';

export interface AuthPlugin {
  readonly name: string;
  authenticate(request: IncomingMessage): Promise<User | null>;
}

export interface DevTokenUser {
  userId: string;
  displayName: string;
  token: string;
}

/** Shorter tokens are guessable enough to matter even on a loopback relay. */
export const MIN_DEV_TOKEN_LENGTH = 24;

const MAX_AUTHORIZATION_LENGTH = 4096;
const BEARER = /^Bearer +([\x21-\x7e]+) *$/i;
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

/**
 * Error messages name the user, never the token, because they end up on a
 * terminal and in CI logs.
 */
export function createDevTokenAuth(users: readonly DevTokenUser[]): AuthPlugin {
  if (users.length === 0) throw new Error('dev-token auth needs at least one user');
  const seenUsers = new Set<string>();
  const entries = users.map((entry) => {
    const user = UserSchema.safeParse({ userId: entry.userId, displayName: entry.displayName });
    if (!user.success) {
      throw new Error(
        `dev-token user ids must be 1 to 64 letters, digits, '_' or '-', with a display name of 1 to 100 characters`,
      );
    }
    if (seenUsers.has(user.data.userId)) {
      throw new Error(`dev-token user ${user.data.userId} is listed twice`);
    }
    seenUsers.add(user.data.userId);
    if (entry.token.length < MIN_DEV_TOKEN_LENGTH) {
      throw new Error(
        `the dev token for ${user.data.userId} is shorter than ${String(MIN_DEV_TOKEN_LENGTH)} characters`,
      );
    }
    if (!TOKEN_CHARS.test(entry.token)) {
      throw new Error(
        `the dev token for ${user.data.userId} must be printable ASCII without spaces`,
      );
    }
    return { user: user.data, digest: digest(entry.token) };
  });
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a && b && sameDigest(a.digest, b.digest)) {
        throw new Error(`dev-token users ${a.user.userId} and ${b.user.userId} share a token`);
      }
    }
  }

  return {
    name: 'dev-token',
    authenticate(request) {
      const presented = bearerToken(request.headers.authorization);
      if (presented === null) return Promise.resolve(null);
      // Hashing both sides gives equal-length buffers for timingSafeEqual, and
      // every entry is compared so the time taken does not say which user matched.
      const candidate = digest(presented);
      let match: User | null = null;
      for (const entry of entries) {
        if (sameDigest(candidate, entry.digest) && match === null) match = entry.user;
      }
      return Promise.resolve(match);
    },
  };
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}

/**
 * Parses TABDOCK_DEV_TOKENS, shaped `alice=<token>,bob=<token>`. The display
 * name is the user id. Only the first '=' splits, so base64 padding survives.
 */
export function parseDevTokens(envValue: string): DevTokenUser[] {
  const users: DevTokenUser[] = [];
  const parts = envValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  parts.forEach((part, index) => {
    const split = part.indexOf('=');
    const userId = split > 0 ? part.slice(0, split).trim() : '';
    const token = split > 0 ? part.slice(split + 1).trim() : '';
    if (userId.length === 0 || token.length === 0) {
      throw new Error(
        `TABDOCK_DEV_TOKENS entry ${String(index + 1)} is not of the form user=token`,
      );
    }
    if (!IdSchema.safeParse(userId).success) {
      throw new Error(
        `TABDOCK_DEV_TOKENS entry ${String(index + 1)} has a user id that is not 1 to 64 letters, digits, '_' or '-'`,
      );
    }
    users.push({ userId, displayName: userId, token });
  });
  if (users.length === 0) throw new Error('TABDOCK_DEV_TOKENS lists no users');
  return users;
}
