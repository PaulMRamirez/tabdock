// The session record (ADR 0045): what the core tells a recorder and what it
// reads back, and createRecorder, which keeps the record. The record is
// advisory, so the core holds a recorder through this interface alone and
// tells it of each change only after making its own decision: nothing a
// recorder returns or throws decides how a call runs (S5 and S6 never read
// it). A record holds names the operator's own screen already showed, in
// memory only, and never arguments, results, images, page state or secrets:
// each hook copies named fields, never a frame or an entry whole, so nothing
// added to those later reaches a record unnoticed. The core keeps one made
// by createRecorder and stops it for NOOP_RECORDER, which keeps nothing, at
// the first fault; CoreOptions.recorder lets a test hand it one of its own.

import {
  type AttachmentView,
  INVITEE_SHORT_ID_CHARS,
  InviteeIdSchema,
  plainLine,
  type Policy,
  type RecordAttachment,
  type RecordCall,
  type RecordOutcome,
  type RecordPerson,
  type RecordProposal,
  type RecordScope,
  SESSION_RECORD_MAX_ATTACHMENTS,
  SESSION_RECORD_MAX_CALLS,
  SESSION_RECORD_MAX_DROPPED_USERS,
  SESSION_RECORD_MAX_PAGE_IDS,
  SESSION_RECORD_MAX_PROPOSALS,
  SESSION_RECORD_MAX_ROLE_CHANGES,
  SESSION_RECORD_VERSION,
  type SessionRecord,
  SessionRecordSchema,
} from '@tabdock/protocol';
import type {
  ActivityEntry,
  PageRole,
  PendingProposal,
  ProposalLogEntry,
  SessionEnded,
  SessionView,
} from './core.ts';

export type { SessionRecord } from '@tabdock/protocol';

/**
 * The three records the adapter may hold at once: the one being kept now,
 * the last page-session record sealed by a new page session, and the last
 * time-boxed session's record sealed at its end.
 */
export type RecordWhich = 'current' | 'previous' | 'ended';

/** How a person came in, as an attachment span records it. */
export type RecordHow = RecordAttachment['how'];

/** How the page let one listed user in: what its grant, or autoApprove, says. */
export interface RecordWayIn {
  readonly how: RecordHow;
  /** The invite that made the grant; null for any other way in. */
  readonly inviteId: string | null;
}

/**
 * One record as DockState.records lists it, for the widget's summary line
 * and its choice of what to save: counts and times, never a name.
 */
export interface RecordView {
  readonly which: RecordWhich;
  /** A page session's record, or a time-boxed session's (ADR 0043). */
  readonly scope: 'page' | 'session';
  /** A time-boxed session's label, the page's own words; null for a page session's record. */
  readonly label: string | null;
  /** Local epoch milliseconds at which the record began. */
  readonly from: number;
  /** When it was sealed; null while it is still being kept. */
  readonly to: number | null;
  readonly calls: number;
  readonly people: number;
  /**
   * How many of those people it names by an email address: an invitee's
   * verified email (ADR 0017), or any name holding one. Not every invitee:
   * an unverified one, one renamed `invitee <short id>` and an agent
   * (ADR 0044) carry none. Told by the '@' every address holds, which a
   * name cut short past the name cap keeps.
   */
  readonly emails: number;
  readonly proposals: number;
  /** Calls, spans and proposals the caps pushed out, so a capped record never passes for a whole one. */
  readonly dropped: number;
  /** A recorder fault stopped it: the widget then offers no save, and says the audit log keeps every call. */
  readonly failed: boolean;
}

/** What a saved record says of its page; read only when the operator saves one. */
export interface RecordContext {
  readonly adapterVersion: string;
  /** The page's origin and path as hello sends them, never a query or fragment. */
  readonly origin: string;
  readonly path: string;
  readonly title: string;
  /** The relay's host alone: its URL's path carries nothing a record needs. */
  readonly relay: string;
  readonly policy: Policy;
}

/** A call's place in the record, so its later changes reach the same entry; null when nothing was kept. */
export type RecordHandle = number | null;

/**
 * What the core tells the recorder, each at the moment its own state
 * changes, and what it reads back. Every method is total: a recorder that
 * throws is stopped by the core's guard, never the call it was told about.
 */
export interface Recorder {
  /** A welcome: a new page session seals the page-scope record, a resumed one keeps it. */
  pageSession(pageId: string, resumed: boolean, at: number): void;
  /** The link went: open spans close at this time should the next welcome start a new page session. */
  linkLost(at: number): void;
  /** The relay's roster and the roles the page enforces, so spans open, change role and close. */
  roster(
    attachments: readonly AttachmentView[],
    roles: readonly PageRole[],
    wayIn: (userId: string) => RecordWayIn,
    at: number,
  ): void;
  /** The operator revoked one user, or everyone with '*', so their spans close as revoked. */
  revoking(target: string): void;
  /** A call the adapter accepted (ADR 0045's notes): never the fixed tools, which never reach the page. */
  call(entry: ActivityEntry, pageId: string): RecordHandle;
  /** The call's line changed: its outcome, its duration, or where it was confirmed. */
  update(handle: RecordHandle, entry: ActivityEntry): void;
  /** The operator allowed the call's prompt, or accepted the proposal that ran it (S6). */
  confirmedOnPage(handle: RecordHandle): void;
  /** A proposal the page took (ADR 0042), never its arguments. */
  proposal(proposal: PendingProposal, pageId: string): void;
  /** How a proposal ended, and the call that ran it when one did. */
  proposalSettled(entry: ProposalLogEntry): void;
  /**
   * A time-boxed session began (ADR 0043): the page-scope record is sealed
   * and a session record starts. Told again of the same session, as when the
   * operator extends it, it takes the session's new end and settings.
   */
  sessionStarted(session: SessionView): void;
  /** It ended: its record, if it holds anything, is sealed into `ended`, and a page-scope record starts again. */
  sessionEnded(ended: SessionEnded): void;
  /** The records held now, the same frozen list until a count changes. */
  views(): readonly RecordView[];
  /** A fresh, schema-checked copy of one record, or null when there is none. */
  snapshot(which: RecordWhich, context: RecordContext, at: number): SessionRecord | null;
  /** Drops a sealed record, or restarts the current one from `at`. */
  discard(which: RecordWhich, at: number): boolean;
  /** Everything goes: the page detached or unloaded. */
  dropAll(): void;
}

const NO_VIEWS: readonly RecordView[] = Object.freeze([]);

/**
 * A recorder that keeps nothing: what the core asks once a fault stopped the
 * record (decision 22), and the list of hooks its guard wraps.
 */
export const NOOP_RECORDER: Recorder = Object.freeze({
  pageSession: () => undefined,
  linkLost: () => undefined,
  roster: () => undefined,
  revoking: () => undefined,
  call: () => null,
  update: () => undefined,
  confirmedOnPage: () => undefined,
  proposal: () => undefined,
  proposalSettled: () => undefined,
  sessionStarted: () => undefined,
  sessionEnded: () => undefined,
  views: () => NO_VIEWS,
  snapshot: () => null,
  discard: () => false,
  dropAll: () => undefined,
});

/** One record as it is kept: its entries already in the schema's shapes, so a snapshot only checks and copies. */
interface Kept {
  scope: RecordScope;
  pageIds: string[];
  from: number;
  /** When it was sealed; null while it is kept. */
  to: number | null;
  spans: RecordAttachment[];
  calls: RecordCall[];
  proposals: RecordProposal[];
  dropped: Omit<SessionRecord['dropped'], 'byUser'>;
  byUser: Map<string, Partial<Record<RecordOutcome, number>>>;
  /** The open spans by user id: who the record says is here now. */
  open: Map<string, RecordAttachment>;
  /**
   * The handle of calls[0]. Handles count every call kept, from 0, so each
   * record covers one run of them and a handle finds its call in whichever
   * record holds it, sealed or not.
   */
  base: number;
  /** Everyone this record names, for the counts the widget's warning gives. */
  seen: Set<RecordPerson>;
  /** The next roster's new spans were there before the record began: a reload resumed the page session. */
  carry: boolean;
}

/**
 * The recorder ADR 0045 describes: a record of the current page session, or
 * of a time-boxed session while one runs, and the last of each kind sealed.
 * Its views always say failed: false, since a fault is caught by the core's
 * guard around every hook (decision 22), which stops the record there.
 */
export function createRecorder(): Recorder {
  let current: Kept | null = null;
  let previous: Kept | null = null;
  let ended: Kept | null = null;
  /** The page session the link is in now: the page new entries belong to. */
  let live = '';
  /** When the link went, which is when a new page session ended the spans still open. */
  let lostAt: number | null = null;
  /**
   * A session's record its end sealed while the link was down. It ended as
   * on a live link, since the relay may resume the page session (a dropped
   * link, or a restart with its snapshot, ADR 0046); a new page session at
   * the next welcome means everyone in it left when the link went instead.
   */
  let endedOffline: Kept | null = null;
  let next = 0;
  let shown = NO_VIEWS;
  /** Users the operator revoked whose spans have not closed yet. */
  const revoked = new Set<string>();
  /**
   * How the records name each user, shared by all three so an invitee's
   * short id, and the ~n that keeps two apart, never differ between them,
   * and pruned to the people they name whenever one is replaced, so the
   * tab keeps no one its records no longer hold.
   */
  const people = new Map<string, RecordPerson>();
  /** The ids `people` hands out, so a clash is found without a scan. */
  const ids = new Set<string>();

  const slots = (): [RecordWhich, Kept | null][] => [
    ['current', current],
    ['previous', previous],
    ['ended', ended],
  ];

  function prune(): void {
    const named = new Set(slots().flatMap(([, kept]) => [...(kept?.seen ?? [])]));
    for (const [userId, held] of people) {
      if (!named.has(held)) {
        people.delete(userId);
        ids.delete(held.id);
      }
    }
  }

  /** The record kept from now on, after whatever it replaced has gone. */
  function start(kept: Kept): void {
    current = kept;
    prune();
  }

  /**
   * A user as the widget names them: a member by id and plain-line name, an
   * invitee by `g_` and the short id the widget shows, never the full account
   * key, which is an unkeyed digest of the provider's subject.
   */
  function person(kept: Kept, userId: string, displayName: string): RecordPerson {
    let named = people.get(userId);
    if (named === undefined) {
      const invitee = InviteeIdSchema.safeParse(userId).success;
      const short = invitee ? userId.slice(0, 2 + INVITEE_SHORT_ID_CHARS) : userId;
      let id = short;
      for (let n = 2; invitee && ids.has(id); n++) id = `${short}~${String(n)}`;
      named = { id, name: plainLine(displayName) || id, kind: invitee ? 'invitee' : 'member' };
      people.set(userId, named);
      ids.add(id);
    }
    kept.seen.add(named);
    return named;
  }

  /** A new record from `from`; whoever `carry` still holds open, and what waits there, was there from the start. */
  function begin(scope: RecordScope, from: number, carry?: Kept): Kept {
    const kept: Kept = {
      scope,
      pageIds: [live],
      from,
      to: null,
      spans: [],
      calls: [],
      proposals: [],
      dropped: {
        calls: 0,
        attachments: 0,
        proposals: 0,
        firstAt: null,
        lastAt: null,
        otherCalls: 0,
      },
      byUser: new Map(),
      open: new Map(),
      base: next,
      seen: new Set(),
      // A session a reload resumed takes over before the first roster, so who is listed was here before.
      carry: carry?.carry === true,
    };
    for (const [userId, span] of carry?.open ?? []) {
      kept.seen.add(span.user);
      open(kept, userId, {
        ...span,
        before: true,
        joinedAt: from,
        roles: [{ at: from, role: span.roles.at(-1)?.role ?? null }],
        rolesDropped: 0,
      });
    }
    for (const proposal of carry?.proposals ?? []) {
      if (proposal.status === 'pending' && proposal.pageId === live) {
        kept.seen.add(proposal.user);
        kept.proposals.push({ ...proposal });
      }
    }
    return kept;
  }

  function open(kept: Kept, userId: string, span: RecordAttachment): void {
    if (kept.spans.length >= SESSION_RECORD_MAX_ATTACHMENTS) {
      // The oldest span that ended goes, as the oldest call does; open ones never come near the cap.
      const index = kept.spans.findIndex((old) => old.leftAt !== null);
      if (index < 0) return;
      kept.spans.splice(index, 1);
      kept.dropped.attachments++;
    }
    kept.spans.push(span);
    kept.open.set(userId, span);
  }

  /** Closes the open spans `why` names a reason for, at `at`. */
  function close(
    kept: Kept,
    at: number,
    why: (userId: string, span: RecordAttachment) => RecordAttachment['ended'],
  ): void {
    for (const [userId, span] of kept.open) {
      span.ended = why(userId, span);
      if (span.ended === null) continue;
      // A span that began after the link went (a record restarted offline) ends as it began.
      span.leftAt = Math.max(at, span.joinedAt);
      kept.open.delete(userId);
    }
  }

  /**
   * The latest time a record holds. The core tells of a session only once
   * the relay has listed it (on this link, or on one before a reload), after
   * a round trip in which calls, role changes and decisions may land, so a
   * record sealed then ends after them, never at the session's start before them.
   */
  function latest(kept: Kept): number {
    let at = kept.from;
    const see = (time: number | null): void => {
      if (time !== null && time > at) at = time;
    };
    for (const call of kept.calls) see(call.at);
    for (const span of kept.spans) {
      see(span.joinedAt);
      see(span.leftAt);
      for (const role of span.roles) see(role.at);
    }
    for (const proposal of kept.proposals) see(proposal.decidedAt);
    return at;
  }

  /** Whether a record holds anything: an empty one never replaces a kept one, which may not be saved yet. */
  const holds = (kept: Kept): boolean =>
    kept.spans.length + kept.calls.length + kept.proposals.length + kept.dropped.calls > 0;

  /**
   * Seals a record that holds anything into its slot. It ends no earlier
   * than anything it holds, so every time it holds lies within its span.
   */
  function seal(kept: Kept, at: number): void {
    if (!holds(kept)) return;
    kept.to = Math.max(at, latest(kept));
    if (kept.scope.kind === 'page') previous = kept;
    else ended = kept;
  }

  /**
   * A call the cap, or a page the record cannot name, pushed out: counted,
   * so the record never passes for whole. Only the cap's drops set the
   * dropped span, which is then older than every call kept.
   */
  function drop(kept: Kept, call: RecordCall): void {
    const { dropped, byUser } = kept;
    dropped.calls++;
    const counts =
      byUser.get(call.user.id) ??
      (byUser.size < SESSION_RECORD_MAX_DROPPED_USERS
        ? byUser.set(call.user.id, {}).get(call.user.id)
        : undefined);
    if (counts === undefined) dropped.otherCalls++;
    else counts[call.outcome] = (counts[call.outcome] ?? 0) + 1;
  }

  function find(handle: RecordHandle): RecordCall | undefined {
    for (const [, kept] of slots()) {
      const call = handle === null ? undefined : kept?.calls[handle - kept.base];
      if (call !== undefined) return call;
    }
    return undefined;
  }

  return {
    pageSession(pageId, resumed, at) {
      const kept = current;
      const same = resumed && pageId === live;
      // When the link went; close and seal keep a record restarted since within its own span.
      const end = lostAt ?? at;
      const offline = endedOffline;
      lostAt = endedOffline = null;
      live = pageId;
      if (kept === null) {
        const first = begin({ kind: 'page' }, at);
        first.carry = resumed;
        start(first);
        return;
      }
      if (same) return;
      if (offline !== null) {
        // The page session ended when the link went, before the session did:
        // everyone in the lesson's record left then, and no one stayed on into
        // the page record its end began, which nothing else can reach offline.
        for (const span of offline.spans) {
          if (span.ended === 'session_ended') offline.open.set(span.user.id, span);
        }
        close(offline, end, () => 'page_session_ended');
        kept.spans = [];
        kept.open.clear();
      }
      // A new page session ended every attachment of the one before (ADR 0019).
      close(kept, end, () => 'page_session_ended');
      if (kept.scope.kind === 'page') {
        seal(kept, end);
        start(begin(kept.scope, at));
      } else if (
        !kept.pageIds.includes(pageId) &&
        kept.pageIds.length < SESSION_RECORD_MAX_PAGE_IDS
      ) {
        // A lesson a deploy interrupted stays one record (ADR 0045's notes from ADR 0043).
        kept.pageIds.push(pageId);
      }
    },

    linkLost(at) {
      lostAt ??= at;
    },

    roster(attachments, roles, wayIn, at) {
      const kept = current;
      if (kept === null || !kept.pageIds.includes(live)) return;
      const listed = new Set<string>();
      for (const { userId, displayName, role: listedRole } of attachments) {
        listed.add(userId);
        const pageRole = roles.find((entry) => entry.userId === userId);
        const role = pageRole === undefined ? listedRole : pageRole.role;
        const span = kept.open.get(userId);
        if (span === undefined) {
          revoked.delete(userId);
          const joinedAt = kept.carry ? kept.from : at;
          open(kept, userId, {
            user: person(kept, userId, displayName),
            pageId: live,
            ...wayIn(userId),
            before: kept.carry,
            joinedAt,
            leftAt: null,
            ended: null,
            roles: [{ at: joinedAt, role }],
            rolesDropped: 0,
          });
        } else if (span.roles.at(-1)?.role !== role) {
          // Past the cap the newest replaces the one before it, so the first and the latest stay.
          if (span.roles.length >= SESSION_RECORD_MAX_ROLE_CHANGES) {
            span.roles.pop();
            span.rolesDropped++;
          }
          span.roles.push({ at, role });
        }
      }
      kept.carry = false;
      close(kept, at, (userId) =>
        listed.has(userId) ? null : revoked.delete(userId) ? 'revoked' : 'left',
      );
    },

    revoking(target) {
      for (const userId of target === '*' ? (current?.open.keys() ?? []) : [target]) {
        revoked.add(userId);
      }
    },

    call(entry, pageId) {
      const kept = current;
      if (kept === null) return null;
      const client = entry.client && plainLine(`${entry.client.name} ${entry.client.version}`);
      const call: RecordCall = {
        callId: entry.callId,
        pageId,
        at: entry.time,
        user: person(kept, entry.user.userId, entry.user.displayName),
        client: client || null,
        tool: entry.tool,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
        confirmedBy: entry.confirmedBy,
        proposalId: entry.proposalId,
      };
      if (!kept.pageIds.includes(pageId)) {
        drop(kept, call);
        return null;
      }
      if (kept.calls.length >= SESSION_RECORD_MAX_CALLS) {
        // The oldest goes first, so the span runs from the first dropped to the latest.
        const oldest = kept.calls.shift() ?? call;
        drop(kept, oldest);
        kept.dropped.firstAt ??= oldest.at;
        kept.dropped.lastAt = oldest.at;
        kept.base++;
      }
      kept.calls.push(call);
      return next++;
    },

    update(handle, entry) {
      const call = find(handle);
      if (call === undefined) return;
      call.outcome = entry.outcome;
      call.durationMs = entry.durationMs;
      // 'page' stays once the operator allowed it: an entry only ever says 'client' or nothing.
      call.confirmedBy = entry.confirmedBy ?? call.confirmedBy;
      call.proposalId = entry.proposalId ?? call.proposalId;
    },

    confirmedOnPage(handle) {
      const call = find(handle);
      if (call !== undefined) call.confirmedBy = 'page';
    },

    proposal(proposal, pageId) {
      const kept = current;
      if (kept === null || !kept.pageIds.includes(pageId)) return;
      if (kept.proposals.length >= SESSION_RECORD_MAX_PROPOSALS) {
        const index = kept.proposals.findIndex((old) => old.status !== 'pending');
        if (index < 0) return;
        kept.proposals.splice(index, 1);
        kept.dropped.proposals++;
      }
      // Its id, proposer, tool and time: never the arguments the queue shows (ADR 0045, decision 25).
      const { proposer } = proposal;
      kept.proposals.push({
        proposalId: proposal.proposalId,
        pageId,
        at: proposal.receivedAt,
        user: person(kept, proposer.userId, proposer.displayName),
        tool: proposal.tool,
        status: 'pending',
        decidedAt: null,
        callId: null,
      });
    },

    proposalSettled(entry) {
      for (const [, kept] of slots()) {
        const proposal = kept?.proposals.find(
          (held) => held.proposalId === entry.proposalId && held.status === 'pending',
        );
        if (proposal === undefined) continue;
        proposal.status = entry.outcome;
        proposal.decidedAt = entry.time;
        proposal.callId = entry.outcome === 'accepted' ? entry.callId : null;
        return;
      }
    },

    sessionStarted(session) {
      const kept = current;
      if (kept === null) return;
      const scope: RecordScope = {
        kind: 'session',
        sessionId: session.sessionId,
        label: session.label,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
        endedAt: null,
        endedBy: null,
        maxDrivers: session.policy.maxDrivers,
        proposals: session.policy.proposals,
        observers: session.observers,
        invites: session.inviteIds.length,
      };
      if (kept.scope.kind === 'session' && kept.scope.sessionId === session.sessionId) {
        kept.scope = scope;
        return;
      }
      // From its start, or after whatever the page record took in before the relay listed it.
      const at = Math.max(session.startedAt, latest(kept));
      seal(kept, at);
      start(begin(scope, at, kept));
    },

    sessionEnded(end) {
      const kept = current;
      if (kept?.scope.kind !== 'session' || kept.scope.sessionId !== end.sessionId) return;
      kept.scope = { ...kept.scope, endedAt: end.time, endedBy: end.reason };
      // The session's end closes every attachment an invite or agent token made (ADR 0043).
      close(kept, end.time, (_userId, span) => (span.inviteId === null ? null : 'session_ended'));
      kept.to = Math.max(end.time, latest(kept));
      if (holds(kept)) ended = kept;
      // Told while the link is down, it ends as a resumed page session will find it.
      if (lostAt !== null) endedOffline = kept;
      start(begin({ kind: 'page' }, kept.to, kept));
    },

    views() {
      const list: RecordView[] = [];
      for (const [which, kept] of slots()) {
        if (kept === null) continue;
        const { scope, dropped } = kept;
        list.push({
          which,
          scope: scope.kind,
          label: scope.kind === 'session' ? scope.label : null,
          from: kept.from,
          to: kept.to,
          calls: kept.calls.length,
          people: kept.seen.size,
          emails: [...kept.seen].filter((named) => named.name.includes('@')).length,
          proposals: kept.proposals.length,
          dropped: dropped.calls + dropped.attachments + dropped.proposals,
          failed: false,
        });
      }
      const key = (views: readonly RecordView[]): string =>
        views.map((view) => Object.values(view).join()).join(';');
      if (key(list) !== key(shown)) shown = Object.freeze(list.map((view) => Object.freeze(view)));
      return shown;
    },

    snapshot(which, context, at) {
      const kept = { current, previous, ended }[which];
      if (kept === null) return null;
      // Checked by the protocol's strict schema before it leaves (ADR 0045, decision 19).
      return Object.freeze(
        SessionRecordSchema.parse({
          format: 'tabdock.session-record',
          v: SESSION_RECORD_VERSION,
          adapterVersion: context.adapterVersion,
          exportedAt: at,
          page: {
            origin: context.origin.slice(0, 2048),
            path: context.path.slice(0, 2048),
            title: plainLine(context.title).slice(0, 300),
          },
          relay: context.relay,
          policy: context.policy,
          pageIds: kept.pageIds,
          scope: kept.scope,
          from: kept.from,
          to: kept.to ?? Math.max(at, kept.from),
          sealed: kept.to !== null,
          attachments: kept.spans,
          calls: kept.calls,
          proposals: kept.proposals,
          dropped: {
            ...kept.dropped,
            byUser: [...kept.byUser].map(([user, counts]) => ({ user, counts })),
          },
        }),
      );
    },

    discard(which, at) {
      const had = { current, previous, ended }[which] !== null;
      if (which === 'previous') previous = null;
      else if (which === 'ended') ended = null;
      else if (current !== null) current = begin(current.scope, at, current);
      prune();
      return had;
    },

    dropAll() {
      current = previous = ended = endedOffline = null;
      lostAt = null;
      live = '';
      revoked.clear();
      people.clear();
      ids.clear();
    },
  };
}
