// Time-boxed sessions in a real browser (ADR 0043): a scripted relay that
// welcomes the demo board, lists every invite it mints and applies its
// session frames as Tabdock's relay does, or holds them for a test to answer;
// the widget's Start form driven with real clicks and keys; and the reads a
// session spec makes of the widget. Shared by specs/session.spec.ts and the
// demo's session leg.

import type { Page, WebSocketRoute } from '@playwright/test';
import type { DemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  type AttachmentView,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
  type Role,
} from '@tabdock/protocol';
import {
  clickInWidget,
  demoPageUrl,
  typeInWidget,
  waitForDock,
  widgetButtonNow,
  widgetEvaluate,
  widgetVisible,
} from './tabdock-harness.ts';

/** Never dialled: routeWebSocket answers in its place. */
export const SESSION_RELAY = 'ws://127.0.0.1:9/page';
export const SESSION_LINK_BASE = 'https://relay.example/i';
const SPONSOR = { userId: 'alice', displayName: 'Alice' };

type Listing = Extract<RelayFrame, { t: 'invites' }>['invites'][number];
type SessionStart = Extract<PageFrame, { t: 'session_start' }>;

export interface SessionRelay {
  /** Every frame the page sent, in order. */
  readonly frames: PageFrame[];
  /** The page's frames of one type. */
  framesOf<T extends PageFrame['t']>(type: T): Extract<PageFrame, { t: T }>[];
  /** What the relay lists, by invite id. */
  readonly listings: Map<string, Listing>;
  /**
   * While true, the relay answers no session frame at all after it listed a
   * session, as a relay whose clock or link has stalled: the page's own end
   * is then the only one.
   */
  silent: boolean;
  /**
   * What the relay says is left of a session it lists, in place of what its
   * own clock says: a relay whose clock runs ahead of the page's, so a test
   * reaches the session's end without waiting out its length.
   */
  remainingMs: number | null;
  send(frame: RelayFrame): void;
  /** The invites frame for what is listed now. */
  list(): void;
}

export function memberEntry(
  userId: string,
  displayName: string,
  role: Role = 'driver',
): AttachmentView {
  return {
    userId,
    displayName,
    kind: 'member',
    role,
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: null,
    endsAt: null,
  };
}

/**
 * Opens the demo board (with `query` added) against a scripted relay that
 * welcomes it with `roster` (Alice, a member driver, unless set), a people
 * limit of 10 and 40 watching seats, offers invites and sessions, lists every
 * invite the page mints, and applies session_start, session_extend and
 * session_end as Tabdock's relay does, never past `silent`.
 */
export async function openWithSessionRelay(
  page: Page,
  demo: DemoServer,
  options: { query?: string; roster?: AttachmentView[] } = {},
): Promise<SessionRelay> {
  const frames: PageFrame[] = [];
  const listings = new Map<string, Listing>();
  let send: ((frame: RelayFrame) => void) | null = null;
  let live: { start: SessionStart; endsAt: number } | null = null;
  const control = { silent: false, remainingMs: null as number | null };
  const list = (): void => {
    send?.({ t: 'invites', linkBase: SESSION_LINK_BASE, invites: [...listings.values()] });
  };
  const listed = (): Extract<RelayFrame, { t: 'session' }>['session'] =>
    live === null
      ? null
      : {
          sessionId: live.start.sessionId,
          lengthMs: live.start.lengthMs,
          remainingMs: control.remainingMs ?? Math.max(0, live.endsAt - Date.now()),
          policy: live.start.policy,
        };
  // Time flows as usual until a test pauses or moves it.
  await page.clock.install();
  await page.routeWebSocket(SESSION_RELAY, (ws: WebSocketRoute) => {
    send = (frame) => {
      ws.send(encodeFrame(frame));
    };
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      const frame = parsed.frame;
      frames.push(frame);
      if (frame.t === 'hello') {
        send?.({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: 'resume-1',
          resumed: false,
          pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
          roster: options.roster ?? [memberEntry('alice', 'Alice')],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            // This relay never pings, so keep the page's silence watchdog out of the way.
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
            usersPerPage: 10,
            observersPerPage: 40,
          },
        });
        list();
        send?.({ t: 'session', session: null });
      } else if (frame.t === 'invite_create') {
        listings.set(frame.inviteId, {
          inviteId: frame.inviteId,
          role: frame.role,
          label: frame.label,
          uses: frame.uses,
          expiresAt: frame.expiresAt,
          usesLeft: frame.uses,
          sponsor: SPONSOR,
          pending: false,
          refusals: 0,
        });
        list();
      } else if (frame.t === 'invite_cancel') {
        listings.delete(frame.inviteId);
        list();
      } else if (control.silent) {
        // Stalled: the page hears nothing more of its session.
      } else if (frame.t === 'session_start') {
        live = { start: frame, endsAt: Date.now() + frame.lengthMs };
        send?.({ t: 'session', session: listed() });
      } else if (frame.t === 'session_extend' && live !== null) {
        live = {
          start: { ...live.start, lengthMs: frame.lengthMs },
          endsAt: live.endsAt + frame.lengthMs - live.start.lengthMs,
        };
        send?.({ t: 'session', session: listed() });
      } else if (frame.t === 'session_end' && live?.start.sessionId === frame.sessionId) {
        live = null;
        listings.clear();
        list();
        send?.({
          t: 'session',
          session: null,
          ended: { sessionId: frame.sessionId, reason: 'operator' },
        });
      }
    });
  });
  const url = demoPageUrl(demo, SESSION_RELAY);
  await page.goto(options.query ? `${url}&${options.query}` : url);
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked' && state.sessionsOffered);
  // The panel opens by itself only while nobody is attached.
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });
  return {
    frames,
    framesOf: <T extends PageFrame['t']>(type: T) =>
      frames.filter((frame): frame is Extract<PageFrame, { t: T }> => frame.t === type),
    listings,
    get silent() {
      return control.silent;
    },
    set silent(value) {
      control.silent = value;
    },
    get remainingMs() {
      return control.remainingMs;
    },
    set remainingMs(value) {
      control.remainingMs = value;
    },
    send(frame) {
      if (!send) throw new Error('the page has not connected');
      send(frame);
    },
    list,
  };
}

export interface SessionForm {
  label: string;
  minutes?: number;
  drivers?: number;
  observers?: number;
}

/** Fills the widget's session form with real clicks and keys, leaving Start to the caller. */
export async function fillSessionForm(page: Page, form: SessionForm): Promise<void> {
  // The label field shows only while the form is open.
  if ((await widgetButtonNow(page, { action: 'session-label' })) === null) {
    await clickInWidget(page, { action: 'session-open' });
  }
  await typeInWidget(page, 'session-label', form.label);
  if (form.minutes !== undefined) await typeInWidget(page, 'session-length', String(form.minutes));
  if (form.drivers !== undefined) await typeInWidget(page, 'session-drivers', String(form.drivers));
  if (form.observers !== undefined) {
    await typeInWidget(page, 'session-observers', String(form.observers));
  }
}

/** Starts a session from the widget's form as the operator does, and waits for it to run. */
export async function startSessionInWidget(page: Page, form: SessionForm): Promise<void> {
  await fillSessionForm(page, form);
  await clickInWidget(page, { action: 'session-start' });
  await waitForDock(page, (state) => state.session !== null && state.session.label === form.label);
}

/**
 * The session link the widget shows beside its QR, read off the session
 * block's link line; '' while none is shown. The link is never in the
 * handle's state, so this is where a spec finds it, as a person reads it.
 */
export async function sessionLinkInWidget(page: Page): Promise<string> {
  const text = await widgetEvaluate(
    page,
    'session',
    "function () { return this.querySelector('.link-text')?.textContent ?? ''; }",
  );
  return typeof text === 'string' ? text : '';
}

/** Stops the page's timers; only runFor moves them on from here. */
export async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 250);
      return;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('to the past')) throw error;
    }
  }
}

/** A redemption of a session link as the relay forwards it: via invite, with the secret presented. */
export function sessionRedemption(
  requestId: string,
  invite: { inviteId: string; label: string },
  link: string,
  user: { userId: string; displayName: string },
): RelayFrame {
  return {
    t: 'attach_request',
    requestId,
    user,
    account: { kind: 'invitee', verified: true },
    via: 'invite',
    invite: {
      inviteId: invite.inviteId,
      secret: link.slice(link.indexOf('#') + 1),
      label: invite.label,
    },
    client: { name: 'claude-ai', version: '1.0' },
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  };
}

/** How far the page scrolls sideways: 0 when nothing is wider than the viewport. */
export function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
