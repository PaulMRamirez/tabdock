// Fixed numbers from SPEC.md sections 5, 6 and 9, plus the M1 choices recorded in
// docs/plans/M1.md and ADR 0005. Relay and adapter both import them, so the two
// sides can never disagree.

/** WebSocket subprotocol for the page link. */
export const SUBPROTOCOL = 'tabdock.v1';

/** Version number carried in the hello frame. */
export const PROTOCOL_VERSION = 1;

/** Largest page link frame either side accepts, in bytes. */
export const MAX_FRAME_BYTES = 1024 * 1024;

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
/** The widget's lifetimes besides "while the page is open": 15 minutes, or an hour by default. */
export const SHORT_INVITE_LIFETIME_MS = 15 * 60_000;
export const DEFAULT_INVITE_LIFETIME_MS = 60 * 60_000;
/** Refusals or timeouts of one control invite's prompts that burn it. */
export const INVITE_BURN_REFUSALS = 3;
/** Seats of a page's user limit that invite-made attachments always leave to members. */
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
