// Relay state behind small interfaces (SPEC section 4). Through M3 everything
// lives in memory; M4 replaces the audit log with a persistent one, and the
// rest can follow without touching the page hub. Interfaces are synchronous on
// purpose: a persistent audit log can write behind, and the hub never has to
// reason about interleaved awaits while it changes attachments.

import type { ClientInfo, ErrorCode, PageTool, Policy, Role } from '@tabdock/protocol';

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
  role: Role;
  grantedAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  /** Clients seen calling through this attachment, newest first. */
  clients: ClientInfo[];
}

export interface PairingTicketRecord {
  pageId: string;
  /** SHA-256 of the normalised code; the code itself only ever goes to the page. */
  codeHash: Buffer;
  expiresAt: number;
}

export interface AttachRequestRecord {
  requestId: string;
  pageId: string;
  userId: string;
  displayName: string;
  via: 'code' | 'qr';
  client: ClientInfo | null;
  expiresAt: number;
}

/**
 * 'cancelled' is a call the MCP client itself abandoned; 'relay_error' is a
 * call the relay failed on its own (a bug), recorded so no attempt escapes S7.
 * Every error code a client sees is recorded as itself.
 */
export type AuditOutcome = 'ok' | 'tool_error' | 'cancelled' | 'relay_error' | ErrorCode;

/** One call_page_tool attempt (S7). Arguments are deliberately absent. */
export interface AuditRecord {
  at: number;
  pageId: string;
  origin: string | null;
  userId: string;
  client: ClientInfo | null;
  tool: string;
  outcome: AuditOutcome;
  durationMs: number;
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

export interface AttachRequestStore {
  get(requestId: string): AttachRequestRecord | undefined;
  put(request: AttachRequestRecord): void;
  delete(requestId: string): void;
  listForPage(pageId: string): AttachRequestRecord[];
}

export interface AuditLog {
  append(record: AuditRecord): void;
  /** Oldest first. */
  records(): AuditRecord[];
}

export interface RelayStore {
  pages: PageStore;
  attachments: AttachmentStore;
  tickets: TicketStore;
  requests: AttachRequestStore;
  audit: AuditLog;
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

/** Keeps the newest `capacity` records; older ones fall off the front. */
export class MemoryAuditLog implements AuditLog {
  readonly #capacity: number;
  readonly #ring: AuditRecord[] = [];

  constructor(capacity = AUDIT_RING_SIZE) {
    this.#capacity = capacity;
  }

  append(record: AuditRecord): void {
    this.#ring.push({ ...record });
    if (this.#ring.length > this.#capacity) {
      this.#ring.splice(0, this.#ring.length - this.#capacity);
    }
  }

  records(): AuditRecord[] {
    return this.#ring.map((record) => ({ ...record }));
  }
}

export function createMemoryStore(options: { auditCapacity?: number } = {}): RelayStore {
  return {
    pages: new MemoryPageStore(),
    attachments: new MemoryAttachmentStore(),
    tickets: new MemoryTicketStore(),
    requests: new MemoryAttachRequestStore(),
    audit: new MemoryAuditLog(options.auditCapacity),
  };
}
