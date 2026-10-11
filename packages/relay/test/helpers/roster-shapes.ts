// The largest roster a page can be sent (ADR 0044): every row as long as the
// schemas let it be, put straight into the relay's store as the relay itself
// keeps attachments. Members' rows list MAX_ROSTER_CLIENTS clients and
// invitees' rows are stored with as many, since clients name themselves on
// every call; only the roster decides how many of an invitee's it sends.
// Text is chosen for its encoded size: a client's name and version in
// characters of three bytes each, which plainLine keeps, and display names in
// control characters, which JSON writes as six bytes each.

import {
  type ClientInfo,
  INVITEE_ID_PREFIX,
  MAX_DISPLAY_NAME_CHARS,
  MAX_INVITE_LIFETIME_MS,
} from '@tabdock/protocol';
import type { AttachmentRecord, RelayStore } from '../../src/index.ts';

/** Clients a member's row keeps and lists, as hub.ts's MAX_ROSTER_CLIENTS. */
export const ROSTER_CLIENTS = 20;
/** ClientInfoSchema's lengths. */
const CLIENT_NAME_CHARS = 100;
const CLIENT_VERSION_CHARS = 50;
/** IdSchema's longest id. */
const ID_CHARS = 64;

/** `count` characters of the CJK block, each three bytes in UTF-8, different for each seed. */
function threeByteText(seed: number, count: number): string {
  let text = '';
  for (let at = 0; at < count; at += 1) {
    text += String.fromCodePoint(0x4e00 + ((seed * 977 + at * 31) % 20_000));
  }
  return text;
}

/** A client whose name and version are as large as they can be once encoded; one per seed. */
export function worstClient(seed: number): ClientInfo {
  return {
    name: threeByteText(seed, CLIENT_NAME_CHARS),
    version: threeByteText(seed + 1, CLIENT_VERSION_CHARS),
  };
}

/** A display name JSON writes at six bytes a character. */
export function worstDisplayName(): string {
  return '\u0001'.repeat(MAX_DISPLAY_NAME_CHARS);
}

/** A member id of the longest length an id may have, different for each index. */
function memberId(index: number): string {
  return `m${String(index)}`.padEnd(ID_CHARS, 'x');
}

/** An invitee's id: the prefix and 32 hex characters, different for each index. */
export function inviteeId(index: number): string {
  return `${INVITEE_ID_PREFIX}${index.toString(16).padStart(32, '0')}`;
}

export interface WorstRoster {
  members: number;
  invitees: number;
}

/**
 * Puts `members` member rows and `invitees` invitee rows on the page, each
 * holding ROSTER_CLIENTS distinct clients, newest first, the invitees
 * watching by an invite of the longest id. Returns the attachments put.
 */
export function putWorstRoster(
  store: RelayStore,
  pageId: string,
  shape: WorstRoster,
): AttachmentRecord[] {
  const now = Date.now();
  const put: AttachmentRecord[] = [];
  let seed = 0;
  const clients = (): ClientInfo[] =>
    Array.from({ length: ROSTER_CLIENTS }, () => worstClient((seed += 2)));
  for (let index = 0; index < shape.members; index += 1) {
    put.push({
      pageId,
      userId: memberId(index),
      displayName: worstDisplayName(),
      kind: 'member',
      role: 'observer',
      grantedAt: now,
      lastUsedAt: now,
      expiresAt: now + 60 * 60_000,
      clients: clients(),
      inviteId: null,
      endsAt: null,
      inviteRole: null,
      sponsorId: null,
      emailHash: null,
    });
  }
  for (let index = 0; index < shape.invitees; index += 1) {
    put.push({
      pageId,
      userId: inviteeId(index),
      displayName: worstDisplayName(),
      kind: 'invitee',
      role: 'observer',
      grantedAt: now,
      lastUsedAt: now,
      expiresAt: now + 60 * 60_000,
      clients: clients(),
      inviteId: `i${String(index)}`.padEnd(ID_CHARS, 'x'),
      endsAt: now + MAX_INVITE_LIFETIME_MS,
      inviteRole: 'observer',
      sponsorId: memberId(0),
      emailHash: 'a'.repeat(64),
    });
  }
  for (const attachment of put) store.attachments.put(attachment);
  return put;
}
