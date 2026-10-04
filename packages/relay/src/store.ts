// Relay state behind small interfaces (SPEC section 4). Everything but the
// audit log lives in memory, and a restart ends it all (ADR 0019); M4 adds a
// persistent audit log (FileAuditLog, workstream C) behind the same AuditLog,
// and invites (workstream A) behind InviteStore. Interfaces are synchronous on
// purpose: a persistent audit log can write behind, and the hub never has to
// reason about interleaved awaits while it changes attachments.

import type {
  AttachVia,
  AuditCallEvent,
  AuditEvent,
  ClientInfo,
  PageTool,
  Policy,
  Role,
  UserKind,
} from '@tabdock/protocol';
import type { UserAccount } from './auth.ts';

export type { AuditOutcome } from '@tabdock/protocol';

export type PageState = 'awake' | 'asleep' | 'gone';

export interface PageRecord {
  pageId: string;
  /** From the WebSocket Origin header only (S1). */
  origin: string;
  title: string;
  url: string;
  adapterVersion: string;
  policy: Policy;
  tools: PageTool[];
  /**
   * True from a resume until the adapter's first tools frame: until then the
   * relay cannot tell a missing tool from one not listed yet, so calls answer
   * page_asleep (try again) instead of tool_not_found. tools is empty meanwhile.
   */
  toolsPending: boolean;
  state: PageState;
  /** SHA-256 of the current resume token, hex. Empty once the page is gone. */
  resumeTokenHash: string;
  connectedAt: number;
  asleepAt: number | null;
  goneAt: number | null;
  /** Who was attached when the page went gone, so they hear page_gone instead of not_attached. */
  formerAttachments: { userId: string; role: Role }[];
}

export interface AttachmentRecord {
  pageId: string;
  userId: string;
  displayName: string;
  /** Member or invitee, as the auth plugin said when the attachment was made (ADR 0017). */
  kind: UserKind;
  role: Role;
  grantedAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  /** Clients seen calling through this attachment, newest first. */
  clients: ClientInfo[];
  /** The invite that made it; null for an approval or autoApprove. */
  inviteId: string | null;
  /** An invite-made attachment's hard end, at most 24 hours after redemption; null otherwise. */
  endsAt: number | null;
}

export interface PairingTicketRecord {
  pageId: string;
  /** SHA-256 of the normalised code; the code itself only ever goes to the page. */
  codeHash: Buffer;
  expiresAt: number;
}

/**
 * What a single-use ticket admits (ADR 0016): 'pair' is the QR nonce beside a
 * page's pairing code. M4's invites reuse the same store with a kind of their own.
 */
export type SingleUseKind = 'pair';

/**
 * A secret that works once, for one page, until it expires. Only its digest is
 * kept; the secret itself goes to the page and from there into a URL fragment.
 */
export interface SingleUseTicketRecord {
  kind: SingleUseKind;
  /** SHA-256 of the secret. */
  secretHash: Buffer;
  pageId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AttachRequestRecord {
  requestId: string;
  pageId: string;
  userId: string;
  displayName: string;
  /** What the page is told about the account: its kind, and whether its name is verified. */
  account: UserAccount;
  via: AttachVia;
  /** The invite being redeemed, exactly when via is invite; never its secret. */
  inviteId: string | null;
  client: ClientInfo | null;
  /**
   * The same user's other clients whose pair_page joined this request, oldest
   * first. They are told they are attached on approval, so the roster names them.
   */
  joined: ClientInfo[];
  expiresAt: number;
}

/**
 * A live invite as the relay keeps it (ADR 0017): its terms, who sponsors it
 * and what is pending on it, but only the digest of its secret, which the
 * adapter alone ever held. An invite lives only in memory, so a restart ends
 * it like everything else (ADR 0019).
 */
export interface InviteRecord {
  /** Drawn by the adapter; unique within its page only, so every lookup names the page too. */
  inviteId: string;
  pageId: string;
  role: Role;
  /** Written by the page (S10): shown as its own words, never logged or audited. */
  label: string;
  uses: number;
  usesLeft: number;
  createdAt: number;
  /** As the page asked; null was "while the page is open". */
  requestedExpiresAt: number | null;
  /** When it stops working: the page's own expiry, never past createdAt plus MAX_INVITE_LIFETIME_MS. */
  expiresAt: number;
  /** SHA-256 of the secret, hex, as invite_create carried it; unique across the relay. */
  secretHash: string;
  /** The member attached longest when it was minted; fixed, since /i has shown the name. */
  sponsor: { userId: string; displayName: string };
  /** The redemption waiting on the operator, if any; a control invite allows one at a time. */
  pendingRequestId: string | null;
  /** Refusals and timeouts so far; INVITE_BURN_REFUSALS burns a control invite. */
  refusals: number;
  /** Accounts revoked from this invite, by user id (for an invitee, the digest of its sub). */
  barredUserIds: string[];
  /** Digests of revoked invitees' verified emails, so a new sign-up with the same address stays out. */
  barredEmailHashes: string[];
}

export interface PageStore {
  get(pageId: string): PageRecord | undefined;
  put(page: PageRecord): void;
  delete(pageId: string): void;
  findByResumeTokenHash(hash: string): PageRecord | undefined;
  all(): PageRecord[];
}

export interface AttachmentStore {
  get(pageId: string, userId: string): AttachmentRecord | undefined;
  put(attachment: AttachmentRecord): void;
  delete(pageId: string, userId: string): boolean;
  listForPage(pageId: string): AttachmentRecord[];
  listForUser(userId: string): AttachmentRecord[];
}

export interface TicketStore {
  /** Replaces the page's previous ticket: one live ticket per page. */
  put(ticket: PairingTicketRecord): void;
  findByCodeHash(hashHex: string): PairingTicketRecord | undefined;
  forPage(pageId: string): PairingTicketRecord | undefined;
  deleteForPage(pageId: string): void;
}

export interface SingleUseTicketStore {
  put(ticket: SingleUseTicketRecord): void;
  /** Looks a ticket up by its digest (hex) without using it. */
  find(kind: SingleUseKind, hashHex: string): SingleUseTicketRecord | undefined;
  /** Finds and removes in one step: whoever takes a ticket is its only user. */
  take(kind: SingleUseKind, hashHex: string): SingleUseTicketRecord | undefined;
  /** Removes every ticket of this kind for the page. */
  deleteForPage(kind: SingleUseKind, pageId: string): void;
}

export interface AttachRequestStore {
  get(requestId: string): AttachRequestRecord | undefined;
  put(request: AttachRequestRecord): void;
  delete(requestId: string): void;
  listForPage(pageId: string): AttachRequestRecord[];
}

/**
 * Live invites (ADR 0017), beside the single-use tickets: an invite has many
 * uses, a sponsor and bars, so it is a record of its own rather than a kind
 * of ticket. Workstream A builds the lifecycle on this store.
 */
export interface InviteStore {
  get(pageId: string, inviteId: string): InviteRecord | undefined;
  /** Looks an invite up by the digest of its secret (hex) without using it. */
  findBySecretHash(hashHex: string): InviteRecord | undefined;
  /** Adds or replaces the page's invite of that id. */
  put(invite: InviteRecord): void;
  /** True if there was one. */
  delete(pageId: string, inviteId: string): boolean;
  /** Oldest first. */
  listForPage(pageId: string): InviteRecord[];
  /** Removes every invite of the page and returns them, for their invite_closed records. */
  deleteForPage(pageId: string): InviteRecord[];
}

/**
 * The audit log (S7, ADR 0019). append takes one record, stays synchronous
 * and never throws, so no call waits on a disk or fails for one. The memory
 * ring keeps the newest records; FileAuditLog (workstream C) also writes them
 * to disk, where only it adds the sequence number and chain link, and needs
 * close() after hub.shutdown(), whose failed calls it must still record.
 */
export interface AuditLog {
  append(event: AuditEvent): void;
  /** The newest records, oldest first, as copies. */
  records(): AuditEvent[];
  close?(): Promise<void>;
}

export interface RelayStore {
  pages: PageStore;
  attachments: AttachmentStore;
  tickets: TicketStore;
  /** Single-use tickets keyed by the digest of their secret (ADR 0016). */
  singleUse: SingleUseTicketStore;
  requests: AttachRequestStore;
  /** Live invites (ADR 0017). */
  invites: InviteStore;
  audit: AuditLog;
}

/** The call records among some audit records, for callers that look only at calls. */
export function callRecords(events: readonly AuditEvent[]): AuditCallEvent[] {
  return events.filter((event): event is AuditCallEvent => event.type === 'call');
}

export const AUDIT_RING_SIZE = 1000;

class MemoryPageStore implements PageStore {
  readonly #pages = new Map<string, PageRecord>();
  readonly #byToken = new Map<string, string>();
  /**
   * The hash each page is indexed under. Callers mutate records in place before
   * put(), so the record itself no longer knows its previous hash; without this
   * a rotated-out resume token would stay usable.
   */
  readonly #indexedHash = new Map<string, string>();

  get(pageId: string): PageRecord | undefined {
    return this.#pages.get(pageId);
  }

  put(page: PageRecord): void {
    this.#unindex(page.pageId);
    this.#pages.set(page.pageId, page);
    if (page.resumeTokenHash !== '') {
      this.#byToken.set(page.resumeTokenHash, page.pageId);
      this.#indexedHash.set(page.pageId, page.resumeTokenHash);
    }
  }

  delete(pageId: string): void {
    this.#unindex(pageId);
    this.#pages.delete(pageId);
  }

  findByResumeTokenHash(hash: string): PageRecord | undefined {
    const pageId = this.#byToken.get(hash);
    const page = pageId === undefined ? undefined : this.#pages.get(pageId);
    return page?.resumeTokenHash === hash ? page : undefined;
  }

  #unindex(pageId: string): void {
    const hash = this.#indexedHash.get(pageId);
    if (hash !== undefined) this.#byToken.delete(hash);
    this.#indexedHash.delete(pageId);
  }

  all(): PageRecord[] {
    return [...this.#pages.values()];
  }
}

class MemoryAttachmentStore implements AttachmentStore {
  readonly #byPage = new Map<string, Map<string, AttachmentRecord>>();

  get(pageId: string, userId: string): AttachmentRecord | undefined {
    return this.#byPage.get(pageId)?.get(userId);
  }

  put(attachment: AttachmentRecord): void {
    let users = this.#byPage.get(attachment.pageId);
    if (!users) {
      users = new Map();
      this.#byPage.set(attachment.pageId, users);
    }
    users.set(attachment.userId, attachment);
  }

  delete(pageId: string, userId: string): boolean {
    const users = this.#byPage.get(pageId);
    if (!users) return false;
    const removed = users.delete(userId);
    if (users.size === 0) this.#byPage.delete(pageId);
    return removed;
  }

  listForPage(pageId: string): AttachmentRecord[] {
    return [...(this.#byPage.get(pageId)?.values() ?? [])];
  }

  listForUser(userId: string): AttachmentRecord[] {
    const out: AttachmentRecord[] = [];
    for (const users of this.#byPage.values()) {
      const attachment = users.get(userId);
      if (attachment) out.push(attachment);
    }
    return out;
  }
}

class MemoryTicketStore implements TicketStore {
  readonly #byHash = new Map<string, PairingTicketRecord>();
  readonly #byPage = new Map<string, string>();

  put(ticket: PairingTicketRecord): void {
    this.deleteForPage(ticket.pageId);
    const hashHex = ticket.codeHash.toString('hex');
    this.#byHash.set(hashHex, ticket);
    this.#byPage.set(ticket.pageId, hashHex);
  }

  findByCodeHash(hashHex: string): PairingTicketRecord | undefined {
    return this.#byHash.get(hashHex);
  }

  forPage(pageId: string): PairingTicketRecord | undefined {
    const hashHex = this.#byPage.get(pageId);
    return hashHex === undefined ? undefined : this.#byHash.get(hashHex);
  }

  deleteForPage(pageId: string): void {
    const hashHex = this.#byPage.get(pageId);
    if (hashHex !== undefined) this.#byHash.delete(hashHex);
    this.#byPage.delete(pageId);
  }
}

class MemorySingleUseTicketStore implements SingleUseTicketStore {
  readonly #byHash = new Map<string, SingleUseTicketRecord>();
  /** Each page's tickets by kind, so a page's end or a rotation finds them without a scan. */
  readonly #byPage = new Map<string, Set<string>>();

  put(ticket: SingleUseTicketRecord): void {
    const key = ticketKey(ticket.kind, ticket.secretHash.toString('hex'));
    this.#forget(key);
    this.#byHash.set(key, ticket);
    const pageKey = ticketKey(ticket.kind, ticket.pageId);
    let keys = this.#byPage.get(pageKey);
    if (!keys) {
      keys = new Set();
      this.#byPage.set(pageKey, keys);
    }
    keys.add(key);
  }

  find(kind: SingleUseKind, hashHex: string): SingleUseTicketRecord | undefined {
    return this.#byHash.get(ticketKey(kind, hashHex));
  }

  take(kind: SingleUseKind, hashHex: string): SingleUseTicketRecord | undefined {
    const key = ticketKey(kind, hashHex);
    const ticket = this.#byHash.get(key);
    this.#forget(key);
    return ticket;
  }

  deleteForPage(kind: SingleUseKind, pageId: string): void {
    const pageKey = ticketKey(kind, pageId);
    for (const key of this.#byPage.get(pageKey) ?? []) this.#byHash.delete(key);
    this.#byPage.delete(pageKey);
  }

  #forget(key: string): void {
    const ticket = this.#byHash.get(key);
    if (!ticket) return;
    this.#byHash.delete(key);
    const pageKey = ticketKey(ticket.kind, ticket.pageId);
    const keys = this.#byPage.get(pageKey);
    keys?.delete(key);
    if (keys?.size === 0) this.#byPage.delete(pageKey);
  }
}

/** A kind and a hex digest or a page id: neither holds a space, so the pair is unambiguous. */
function ticketKey(kind: SingleUseKind, value: string): string {
  return `${kind} ${value}`;
}

class MemoryAttachRequestStore implements AttachRequestStore {
  readonly #requests = new Map<string, AttachRequestRecord>();

  get(requestId: string): AttachRequestRecord | undefined {
    return this.#requests.get(requestId);
  }

  put(request: AttachRequestRecord): void {
    this.#requests.set(request.requestId, request);
  }

  delete(requestId: string): void {
    this.#requests.delete(requestId);
  }

  listForPage(pageId: string): AttachRequestRecord[] {
    return [...this.#requests.values()].filter((request) => request.pageId === pageId);
  }
}

/** In memory only; workstream A may add indexes (by sponsor, say) as the lifecycle needs them. */
export class MemoryInviteStore implements InviteStore {
  /** Each page's invites by id, oldest first, as a Map keeps insertion order. */
  readonly #byPage = new Map<string, Map<string, InviteRecord>>();
  /** Secret digest (hex) to page and invite id. */
  readonly #byHash = new Map<string, { pageId: string; inviteId: string }>();

  get(pageId: string, inviteId: string): InviteRecord | undefined {
    return this.#byPage.get(pageId)?.get(inviteId);
  }

  findBySecretHash(hashHex: string): InviteRecord | undefined {
    const ref = this.#byHash.get(hashHex);
    return ref === undefined ? undefined : this.get(ref.pageId, ref.inviteId);
  }

  put(invite: InviteRecord): void {
    // A replaced record may carry another digest; the old one must stop finding it.
    const previous = this.get(invite.pageId, invite.inviteId);
    if (previous) this.#byHash.delete(previous.secretHash);
    let invites = this.#byPage.get(invite.pageId);
    if (!invites) {
      invites = new Map();
      this.#byPage.set(invite.pageId, invites);
    }
    invites.set(invite.inviteId, invite);
    this.#byHash.set(invite.secretHash, { pageId: invite.pageId, inviteId: invite.inviteId });
  }

  delete(pageId: string, inviteId: string): boolean {
    const invites = this.#byPage.get(pageId);
    const invite = invites?.get(inviteId);
    if (!invites || !invite) return false;
    invites.delete(inviteId);
    if (invites.size === 0) this.#byPage.delete(pageId);
    this.#byHash.delete(invite.secretHash);
    return true;
  }

  listForPage(pageId: string): InviteRecord[] {
    return [...(this.#byPage.get(pageId)?.values() ?? [])];
  }

  deleteForPage(pageId: string): InviteRecord[] {
    const removed = this.listForPage(pageId);
    for (const invite of removed) this.#byHash.delete(invite.secretHash);
    this.#byPage.delete(pageId);
    return removed;
  }
}

/** Keeps the newest `capacity` records; older ones fall off the front. */
export class MemoryAuditLog implements AuditLog {
  readonly #capacity: number;
  readonly #ring: AuditEvent[] = [];

  constructor(capacity = AUDIT_RING_SIZE) {
    this.#capacity = capacity;
  }

  append(event: AuditEvent): void {
    this.#ring.push(structuredClone(event));
    if (this.#ring.length > this.#capacity) {
      this.#ring.splice(0, this.#ring.length - this.#capacity);
    }
  }

  records(): AuditEvent[] {
    return this.#ring.map((event) => structuredClone(event));
  }
}

export function createMemoryStore(options: { auditCapacity?: number } = {}): RelayStore {
  return {
    pages: new MemoryPageStore(),
    attachments: new MemoryAttachmentStore(),
    tickets: new MemoryTicketStore(),
    singleUse: new MemorySingleUseTicketStore(),
    requests: new MemoryAttachRequestStore(),
    invites: new MemoryInviteStore(),
    audit: new MemoryAuditLog(options.auditCapacity),
  };
}
