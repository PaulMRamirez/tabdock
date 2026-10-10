// Fixed numbers from SPEC.md sections 5, 6 and 9, plus the M1 choices recorded in
// docs/plans/M1.md and ADR 0005. Relay and adapter both import them, so the two
// sides can never disagree.

/** WebSocket subprotocol for the page link. */
export const SUBPROTOCOL = 'tabdock.v1';

/** Version number carried in the hello frame. */
export const PROTOCOL_VERSION = 1;

/** Largest page link frame either side accepts, in bytes. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The most an invoke's confirmation (ADR 0026) adds to its encoded frame:
 * `,"confirmation":{"by":"client","confirmationId":"<64 id characters>","at":<a
 * safe integer>}`. The relay measures every invoke with this much to spare,
 * so a call that fits when it arrives still fits once confirmed, and nobody
 * is asked about a call too large to send (ADR 0032).
 */
export const MAX_CONFIRMATION_FRAME_BYTES = 137;

/** Tool results longer than this many characters are truncated with a visible marker. */
export const MAX_RESULT_CHARS = 120_000;

/** Page-supplied tool descriptions are cut to this length before any client sees them (S10). */
export const MAX_DESCRIPTION_CHARS = 1000;

/** Most tools one page may publish. */
export const MAX_TOOLS_PER_PAGE = 128;

/** The relay pings every 15 s and drops a socket after 30 s of silence. */
export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 30_000;

/** An asleep page keeps its attachments for this long before it is gone. */
export const RESUME_WINDOW_MS = 10 * 60_000;

/** A pairing code lives this long and works once. */
export const PAIRING_TTL_MS = 120_000;

/** An attach request waits this long for the operator; silence means deny. */
export const ATTACH_REQUEST_TTL_MS = 60_000;

/**
 * pair_page waits at most this long, under the 60 s first-byte timer Claude Code
 * applies to HTTP tool calls (ADR 0005). The request itself stays open on the page
 * for the full ATTACH_REQUEST_TTL_MS.
 */
export const PAIR_WAIT_MS = 50_000;

/** Default time a page gets to answer one call. */
export const DEFAULT_CALL_DEADLINE_MS = 45_000;

/**
 * The longest delay setTimeout honours, in browsers and Node alike. A longer
 * one fires early: Chromium ran a 2^31 ms timer at once and wrapped 2^32 +
 * 5000 ms to 5 s, and Node runs it after 1 ms. So the relay refuses timings
 * past it and the adapter caps a relay's deadline under it (ADR 0030).
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** The adapter re-reads the tool list this often in case toolchange never fires. */
export const TOOL_POLL_MS = 2000;

/** Reconnect backoff bounds for the adapter. */
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

// Close codes on the page link. The standard ones in use: 1001 (relay idle
// timeout or shutdown), 1008 (malformed frame, or too many tools frames), 1009
// (frame too large), 1013 (no room for a new page session; try again). Browsers
// let page code send only 1000 and 3000 to 4999, so codes a page sends sit in the
// 4000 range. Only CLOSE_DETACH ends a session at once; every other close leaves
// the page asleep for the resume window (SPEC section 6, ADR 0007).

// Invites (ADRs 0016 and 0017). The adapter and the relay both enforce these,
// so a number changes here or nowhere.

/** Where an invite link lands: `<public URL>/i#<secret>`, the secret only in the fragment. */
export const INVITE_PATH = '/i';
/** An invite secret's randomness: 128 bits, as 22 base64url characters (S11). */
export const INVITE_SECRET_BYTES = 16;
export const INVITE_SECRET_CHARS = 22;
/** A label the operator gives an invite; page-written text (S10). */
export const MAX_INVITE_LABEL_CHARS = 60;
/** Uses one watch invite may have; a control invite always has CONTROL_INVITE_USES. */
export const MAX_INVITE_USES = 20;
export const CONTROL_INVITE_USES = 1;
/** Invites one page may hold live at once. */
export const MAX_LIVE_INVITES_PER_PAGE = 10;
/**
 * The longest any invite lives, "while the page is open" included, and how
 * long after redemption an invite-made attachment ends at the latest.
 */
export const MAX_INVITE_LIFETIME_MS = 24 * 60 * 60_000;
/**
 * The least time an invite_create's expiresAt must still have on the relay's
 * clock, or the relay refuses it as expired: the page set it on its own
 * clock, which may run behind (ADR 0017's notes).
 */
export const MIN_INVITE_REMAINING_MS = 60_000;
/** The widget's lifetimes besides "while the page is open": 15 minutes, or an hour by default. */
export const SHORT_INVITE_LIFETIME_MS = 15 * 60_000;
export const DEFAULT_INVITE_LIFETIME_MS = 60 * 60_000;
/** Refusals or timeouts of one control invite's prompts that burn it. */
export const INVITE_BURN_REFUSALS = 3;
/**
 * Seats of a page's people limit that invite-made attachments always leave to
 * members. It applies to the people limit only: invitees watching from the
 * watching seats (ADR 0044) never take a member's seat, so none is kept there.
 */
export const MEMBER_RESERVED_SEATS = 2;
/** pair_page's invite input: a link or its bare secret, never longer than this. */
export const MAX_INVITE_INPUT_CHARS = 300;
/** pair_page's code input, as M1 bounded it. */
export const MAX_CODE_INPUT_CHARS = 64;

// Accounts (ADRs 0017 and 0020).

/** An invitee's user id is this and the 32 hex characters of its account key; the config refuses it for members. */
export const INVITEE_ID_PREFIX = 'g_';
export const INVITEE_KEY_HEX_CHARS = 32;
/** The widget always shows this many characters of an invitee's key beside its name. */
export const INVITEE_SHORT_ID_CHARS = 8;
/** What an invitee is called when the provider vouches for no email. */
export const UNVERIFIED_ACCOUNT_NAME = 'unverified account';
/** RFC 5321's longest address; a longer claim reads as none. */
export const MAX_EMAIL_CHARS = 320;
/** A user's display name on the wire; an invitee's email is cut to 97 characters and '...' to fit. */
export const MAX_DISPLAY_NAME_CHARS = 100;

// First-class page tools (ADR 0025): SPEC section 7's and S9's numbers. Only
// the relay uses them, and they live here beside the rest so a number changes
// here or nowhere.

/**
 * The longest first-class name, `<page id>__<tool>`, the relay lists: connector
 * review's cap, which leaves 49 characters for the tool's own name.
 */
export const MAX_FIRST_CLASS_NAME_CHARS = 64;
/** Page tools in one user's first-class list (S9). */
export const MAX_FIRST_CLASS_TOOLS_PER_USER = 64;
/** Characters of one user's first-class entries, counted as JSON text (S9). */
export const MAX_FIRST_CLASS_CHARS_PER_USER = 100_000;
/** A first-class entry's whole description, the relay's prefix included (S10). */
export const MAX_FIRST_CLASS_DESCRIPTION_CHARS = 500;
/** A first-class entry's title, the origin's host included; the page's part is what is cut. */
export const MAX_FIRST_CLASS_TITLE_CHARS = 120;
/** Characters of the page's origin that the description's prefix names. */
export const MAX_FIRST_CLASS_ORIGIN_CHARS = 100;
/** ttlMs on a 2026-07-28 tools/list while first-class tools are on, always with cacheScope private. */
export const FIRST_CLASS_LIST_TTL_MS = 10_000;
/**
 * The least time between two tool list change notifications to one user: a
 * list's own ttlMs. Every 2026-07-28 tools/list spends the request budget
 * (ADR 0030), and a client lists again on each change, so at one a second a
 * page that kept changing its tools spent a member's whole 240 a minute
 * through four clients; at one every 10 s four clients spend 24 (ADR 0032).
 */
export const FIRST_CLASS_NOTIFY_INTERVAL_MS = 10_000;

// M6 (ADRs 0039 to 0046). The adapter and the relay enforce each of these on
// their own side, so a number changes here or nowhere.

// Images (ADR 0039)
/** The ceiling of TABDOCK_MAX_IMAGE_BYTES, in decoded bytes: an answer at it is no larger than ADR 0030's text answer. */
export const MAX_IMAGE_BYTES = 524_288;
/** TABDOCK_MAX_IMAGE_BYTES by default: its base64 stays under Claude Code's default output tokens. */
export const DEFAULT_IMAGE_BYTES = 65_536;
/** The most text an image result carries beside its image; the image itself is never cut. */
export const MAX_IMAGE_TEXT_CHARS = 2_000;
/** The longest side an image's header may declare, so a small file cannot unpack into a huge bitmap. */
export const MAX_IMAGE_SIDE = 8_192;
/** The most pixels an image's header may declare in all. */
export const MAX_IMAGE_PIXELS = 16_777_216;
// Page state and waiting fixed tools (ADRs 0040 and 0042)
/** UTF-8 bytes of a published value's canonical JSON. */
export const MAX_STATE_BYTES = 16_384;
/** The most a whole state frame may take on the wire: the value and its wrapping. */
export const MAX_STATE_FRAME_BYTES = MAX_STATE_BYTES + 64;
/** The least time between two state frames from one adapter. */
export const STATE_MIN_INTERVAL_MS = 500;
/** How long wait_for_page_state waits when the caller names no time. */
export const DEFAULT_STATE_WAIT_MS = 25_000;
/** The longest any fixed tool waits: under the call deadline and Claude Code's 60 s first byte. */
export const MAX_WAIT_MS = 40_000;
/** Waiting fixed tool calls one user may hold at once, across every page and both waiting tools. */
export const MAX_WAITS_PER_USER = 2;
// Proposals (ADR 0042)
/** How long a proposal waits for the operator; both sides end it on their own clocks. */
export const PROPOSAL_TTL_MS = 600_000;
/** Pending proposals one user may hold on one page. */
export const MAX_PENDING_PROPOSALS_PER_USER = 3;
/** Pending proposals one page may hold. */
export const MAX_PENDING_PROPOSALS_PER_PAGE = 20;
/** UTF-8 bytes of a proposal's arguments as canonical JSON, since a proposal outlives its request's charge. */
export const MAX_PROPOSAL_ARGUMENT_BYTES = 16_384;
/** Values and keys in a proposal's arguments, for the same reason. */
export const MAX_PROPOSAL_ARGUMENT_NODES = 1_000;
/** How long after the operator's Accept the adapter still runs the accepted call: one deadline and a margin. */
export const ACCEPTED_PROPOSAL_RUN_MS = DEFAULT_CALL_DEADLINE_MS + 15_000;
/** How long a settled proposal's outcome stays readable. */
export const PROPOSAL_OUTCOME_KEEP_MS = 600_000;
/** Settled proposals one page keeps readable; the oldest goes first. */
export const MAX_SETTLED_PROPOSALS_PER_PAGE = 40;
/** Characters of an accepted run's result a proposal keeps, cut with the visible marker. */
export const MAX_PROPOSAL_RESULT_CHARS = 20_000;
// Time-boxed sessions, members file, restart snapshot (ADRs 0043 and 0046)
/** The shortest time-boxed session: 30 minutes. */
export const MIN_SESSION_MS = 1_800_000;
/** The longest time-boxed session, extensions included: 4 hours. */
export const MAX_SESSION_MS = 14_400_000;
/** Session lengths are whole minutes. */
export const SESSION_LENGTH_UNIT_MS = 60_000;
/** The widget's step when the operator extends a session: 15 minutes. */
export const SESSION_EXTEND_MS = 900_000;
/** When the widget warns before a session ends: 5 minutes and 1 minute before. */
export const SESSION_WARNINGS_MS = [300_000, 60_000] as const;
/** After its own timer ends a session, the adapter sends session_end this much later, leaving the relay's end on its own clock time to arrive. */
export const SESSION_END_GRACE_MS = 5_000;
/** Entries the members file may hold. */
export const MAX_MEMBERS = 500;
/** The largest members file the relay reads. */
export const MAX_MEMBERS_FILE_BYTES = 262_144;
/** How often the relay looks at the members file for a change. */
export const MEMBERS_POLL_MS = 2_000;
/** The version a restart snapshot carries; any other is not read. */
export const SNAPSHOT_VERSION = 1;
// Rooms and agent tokens (ADR 0044)
/** The ceiling of TABDOCK_MAX_OBSERVERS_PER_PAGE, the watching seats beside the people limit. */
export const MAX_OBSERVERS_PER_PAGE = 100;
/** The ceiling of TABDOCK_MAX_USERS_PER_PAGE, the people limit. */
export const MAX_USERS_PER_PAGE = 50;
/** Clients an invitee's roster row lists, newest first, so a room's welcome stays well under the frame cap. */
export const MAX_ROSTER_CLIENTS_PER_INVITEE = 2;
/** Where an agent token's client connects, beside the relay's /mcp. */
export const AGENT_PATH = '/g/mcp';
/** What every agent token starts with, so a scanner or a person can tell one at sight. */
export const AGENT_TOKEN_PREFIX = 'tda_';
/** An agent token's randomness: 256 bits, as 43 base64url characters after the prefix (S11). */
export const AGENT_TOKEN_BYTES = 32;
export const AGENT_TOKEN_CHARS = 47;
/** The widget's lifetimes for an agent token: an hour by default, at most 8 hours. */
export const DEFAULT_AGENT_LIFETIME_MS = 3_600_000;
export const MAX_AGENT_LIFETIME_MS = 28_800_000;
export const AGENT_LIFETIMES_MS = [3_600_000, 14_400_000, 28_800_000] as const;
/** Agent tokens one page may hold live at once. */
export const MAX_LIVE_AGENTS_PER_PAGE = 10;
/** Unanswered prompts that burn an agent token; one denial burns it at once. */
export const AGENT_BURN_TIMEOUTS = 3;
/** The first line of the text an agent's user id is hashed from; see agentKeyInput. */
export const AGENT_KEY_DOMAIN = 'tabdock agent';
// Session record (ADR 0045)
/** The version a saved session record carries. */
export const SESSION_RECORD_VERSION = 1;
/** Calls one record holds; past it the oldest are dropped and counted. */
export const SESSION_RECORD_MAX_CALLS = 5_000;
/** Attachment spans one record holds. */
export const SESSION_RECORD_MAX_ATTACHMENTS = 500;
/** Proposals one record holds. */
export const SESSION_RECORD_MAX_PROPOSALS = 1_000;
/** Page sessions one record spans, since a time-boxed session survives a relay restart. */
export const SESSION_RECORD_MAX_PAGE_IDS = 16;
/** Role changes one attachment span keeps. */
export const SESSION_RECORD_MAX_ROLE_CHANGES = 16;
/** Users whose dropped calls a record counts by name; the rest are counted together. */
export const SESSION_RECORD_MAX_DROPPED_USERS = 200;
/** The largest record file the audit reader's --match opens; a full record is about 3 MB. */
export const SESSION_RECORD_MAX_BYTES = 8_388_608;

// The audit log (ADR 0019).

/** The version every audit record carries. */
export const AUDIT_VERSION = 1;
/** Accounts a relay-wide refused_summary names; the rest are counted together. */
export const REFUSED_SUMMARY_BUSIEST = 20;

/** The page detached on purpose; the relay ends its session at once instead of keeping it asleep. */
export const CLOSE_DETACH = 4000;
/** A newer socket resumed this page's session; the old socket must not reconnect. */
export const CLOSE_REPLACED = 4001;
/** The page heard nothing from the relay for too long and is reconnecting; its session stays resumable. */
export const CLOSE_SILENT = 4002;
/** The page received a malformed frame: the browser's stand-in for 1008, which page code cannot send. */
export const CLOSE_INVALID_FRAME_PAGE = 4008;
