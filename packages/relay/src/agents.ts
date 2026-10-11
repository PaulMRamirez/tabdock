// Each page's agent tokens (ADR 0044): bearer credentials for /g/mcp that
// watch one page while a member sponsors them, kept only as digests and
// closed with the page, their sponsor or a time-boxed session's end. Neither
// a token nor its digest ever reaches a line or a record.
//
// This part keeps the records' lifecycle (their expiry timers, the digest
// lookup and the one agent_closed record each token gets) and hears of the
// page's life as every page part does. What a token's close ends in the hub
// (its waiting request, its attachment) and beyond it (its MCP sessions and
// listen streams) is the hub's `closed` hook, called after the record has
// gone, so nothing the hook ends can find the token live again.

import {
  type AgentListing,
  AgentTokenSchema,
  AUDIT_VERSION,
  type AuditEvent,
  type AuditEventOf,
} from '@tabdock/protocol';
import type { Logger } from './log.ts';
import type { PagePart } from './page-parts.ts';
import { digest, sameDigest } from './secrets.ts';
import type { AgentStore, AgentTokenRecord } from './store.ts';

/** Why a token stopped being live, as its agent_closed record names it. */
export type AgentCloseReason = AuditEventOf<'agent_closed'>['reason'];

export interface AgentTokensOptions {
  store: AgentStore;
  log: Logger;
  /** The hub's own audit writer, so the record reaches the log and its stderr copy. */
  audit(event: AuditEvent): void;
  /** The page's origin for a record: from its socket's Origin header (S1). */
  originOf(pageId: string): string;
  /** After a token's record went: end what it held (ADR 0044's notes on a token's close). */
  closed(agent: AgentTokenRecord, reason: AgentCloseReason): void;
}

/** A page and an id within it: neither holds a space, so the pair is unambiguous. */
function keyOf(pageId: string, id: string): string {
  return `${pageId} ${id}`;
}

export class AgentTokens implements PagePart {
  readonly #options: AgentTokensOptions;
  /** One per live token, keyed by page and token id: fires at its expiresAt. */
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Each live token's agent user, so a caller's one page is known without a scan (S13). */
  readonly #byUser = new Map<string, { pageId: string; tokenId: string }>();
  /** Tokens a sponsor's end closed, by page and sponsor, until #loseSponsors counts them. */
  readonly #sponsorClosed = new Map<string, number>();

  constructor(options: AgentTokensOptions) {
    this.#options = options;
  }

  /** A token the hub checked and minted: kept, timed and recorded, never with its digest. */
  mint(agent: AgentTokenRecord): void {
    this.#options.store.put(agent);
    this.#byUser.set(agent.userId, { pageId: agent.pageId, tokenId: agent.tokenId });
    this.#arm(agent);
    this.#options.audit({
      v: AUDIT_VERSION,
      type: 'agent_minted',
      at: agent.createdAt,
      pageId: agent.pageId,
      origin: this.#options.originOf(agent.pageId),
      tokenId: agent.tokenId,
      expiresAt: agent.expiresAt,
      sponsor: agent.sponsor.userId,
    });
    this.#options.log.info('agent token minted', { pageId: agent.pageId, tokenId: agent.tokenId });
  }

  /**
   * The live token a presented one names: found by digest and confirmed in
   * constant time, as codes, nonces and invites are (S3), and within its
   * time, a token found past it closing now, however late its timer. Any
   * miss is null alike, so /g/mcp answers every one with the same 404.
   */
  byToken(token: string, now: number): AgentTokenRecord | null {
    if (!AgentTokenSchema.safeParse(token).success) return null;
    const hash = digest(token);
    const agent = this.#options.store.findBySecretHash(hash.toString('hex'));
    if (!agent || !sameDigest(Buffer.from(agent.secretHash, 'hex'), hash)) return null;
    return this.inTime(agent, now) ? agent : null;
  }

  /** Whether the token is still live and within its time; one found past it closes now. */
  inTime(agent: AgentTokenRecord, now: number): boolean {
    if (this.#options.store.get(agent.pageId, agent.tokenId) !== agent) return false;
    if (agent.expiresAt > now) return true;
    this.end(agent, 'expired');
    return false;
  }

  /** The page a live token's agent user watches, or null for any other user. */
  pageOf(userId: string): string | null {
    return this.#byUser.get(userId)?.pageId ?? null;
  }

  /** The live token behind an agent user, or null. */
  ofUser(userId: string): AgentTokenRecord | null {
    const ref = this.#byUser.get(userId);
    return ref === undefined ? null : (this.#options.store.get(ref.pageId, ref.tokenId) ?? null);
  }

  /** How the agents frame lists a token: the page's own terms back, never the token or its digest. */
  listing(agent: AgentTokenRecord): AgentListing {
    return {
      tokenId: agent.tokenId,
      label: agent.label,
      // On the page's clock, as it asked, so the adapter matches its own record.
      expiresAt: agent.requestedExpiresAt,
      sponsor: { ...agent.sponsor },
      state: agent.state,
      timeouts: agent.timeouts,
    };
  }

  /**
   * A token stops being live, once: its record, timer and user go, its one
   * agent_closed record is written, and then the hub ends what it held.
   * False when it was not live, so a second end of one token is nothing.
   */
  end(agent: AgentTokenRecord, reason: AgentCloseReason): boolean {
    const { pageId, tokenId } = agent;
    if (!this.#options.store.delete(pageId, tokenId)) return false;
    this.#clear(pageId, tokenId);
    if (this.#byUser.get(agent.userId)?.tokenId === tokenId) this.#byUser.delete(agent.userId);
    this.#options.audit({
      v: AUDIT_VERSION,
      type: 'agent_closed',
      at: Date.now(),
      pageId,
      origin: this.#options.originOf(pageId),
      tokenId,
      reason,
    });
    this.#options.log.info('agent token closed', { pageId, tokenId, reason });
    this.#options.closed(agent, reason);
    return true;
  }

  /**
   * Closes every live token of the page for one reason, as a page's end,
   * Revoke all or a time-boxed session's end does (ADR 0043's C11), and
   * says how many.
   */
  closePage(pageId: string, reason: AgentCloseReason): number {
    let closed = 0;
    for (const agent of this.#options.store.listForPage(pageId)) {
      if (this.end(agent, reason)) closed += 1;
    }
    return closed;
  }

  /**
   * How many tokens a sponsor's end closed (attachmentsEnded, which every
   * end of an attachment passes through), for the sponsor_gone record to
   * count beside their invites, so it says everything the sponsor's end
   * took (S14). Taken once.
   */
  sponsorGone(pageId: string, sponsorId: string): number {
    const key = keyOf(pageId, sponsorId);
    const closed = this.#sponsorClosed.get(key) ?? 0;
    this.#sponsorClosed.delete(key);
    return closed;
  }

  // The page's life (page-parts.ts)

  sleep(): void {
    // A sleep drops the page's attach requests (hub.ts, #dropRequests), which
    // returns a token asking the operator to dormant; the tokens themselves
    // and their attachments wait out the resume window as invites do.
  }

  resumed(): void {
    // Likewise: a reload never saw the requests the old socket was asked.
  }

  gone(pageId: string): void {
    this.closePage(pageId, 'page_gone');
    for (const key of [...this.#sponsorClosed.keys()]) {
      if (key.startsWith(`${pageId} `)) this.#sponsorClosed.delete(key);
    }
  }

  /**
   * These users' attachments ended, however (S8): a token dies with its
   * agent's attachment, so a later request finds nothing and gets 404, and
   * with its sponsor's, as an invite does (S14). An attachment ending at the
   * token's time closes it as expired; ended any other way (revoked, unused
   * too long, detached, its session's end) it closes as revoked, its access
   * taken away. A member a member list change removed ends here too, so
   * their tokens go with the attachments that change ended (ADR 0043), and a
   * second pass over the same users finds nothing left to close.
   */
  attachmentsEnded(pageId: string, users: ReadonlySet<string>): void {
    const now = Date.now();
    for (const agent of this.#options.store.listForPage(pageId)) {
      if (users.has(agent.userId)) {
        this.end(agent, agent.expiresAt <= now ? 'expired' : 'revoked');
      } else if (users.has(agent.sponsor.userId) && this.end(agent, 'sponsor_gone')) {
        const key = keyOf(pageId, agent.sponsor.userId);
        this.#sponsorClosed.set(key, (this.#sponsorClosed.get(key) ?? 0) + 1);
      }
    }
  }

  policyChanged(): void {
    // A session sets only maxDrivers and proposals (ADR 0043), and a token
    // only ever watches, so neither narrows what a token may do.
  }

  /** The relay is shutting down: every timer stops, and no line or record is written. */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #arm(agent: AgentTokenRecord): void {
    const { pageId, tokenId } = agent;
    this.#clear(pageId, tokenId);
    const timer = setTimeout(
      () => {
        this.#timers.delete(keyOf(pageId, tokenId));
        const current = this.#options.store.get(pageId, tokenId);
        if (current === undefined) return;
        // A timer that ran early arms again; inTime closes one that is due.
        if (this.inTime(current, Date.now())) this.#arm(current);
      },
      Math.max(0, agent.expiresAt - Date.now()),
    );
    timer.unref();
    this.#timers.set(keyOf(pageId, tokenId), timer);
  }

  #clear(pageId: string, tokenId: string): void {
    const key = keyOf(pageId, tokenId);
    const timer = this.#timers.get(key);
    if (timer) clearTimeout(timer);
    this.#timers.delete(key);
  }
}
