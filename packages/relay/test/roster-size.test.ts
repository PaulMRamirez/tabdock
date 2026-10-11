// ADR 0044, A6.21: the largest roster a page can be sent fits one page link
// frame with room to spare. Clients name themselves on every call, so a room
// of guests each rotating names could grow its rows until the welcome passed
// MAX_FRAME_BYTES; the adapter refuses such a frame (close 4008) and
// reconnects into the same welcome, so the operator's page would never link.
// An invitee's row therefore lists only its newest clients, and the people
// limit has a ceiling (MAX_USERS_PER_PAGE), so the worst case is bounded.

import {
  encodeFrame,
  MAX_FRAME_BYTES,
  MAX_OBSERVERS_PER_PAGE,
  MAX_ROSTER_CLIENTS_PER_INVITEE,
  MAX_USERS_PER_PAGE,
  type RelayFrame,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type InviteRelay, startInviteRelay } from './helpers/invites.ts';
import { openSocket, TestPage } from './helpers/page-client.ts';
import { putWorstRoster, ROSTER_CLIENTS } from './helpers/roster-shapes.ts';

/** The bound the design holds the worst welcome to: three quarters of a frame. */
const WELCOME_BOUND_BYTES = 768 * 1024;

let current: InviteRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Opens the page again with its resume token, keeping the welcome's bytes exactly as they came. */
async function resume(
  relay: InviteRelay,
  token: string,
): Promise<{ page: TestPage; welcomeBytes: number }> {
  const ws = await openSocket(relay.relay.pageUrl, { protocols: [SUBPROTOCOL] });
  const sizes: number[] = [];
  ws.on('message', (data: Buffer) => {
    sizes.push(data.length);
  });
  const page = new TestPage(ws);
  page.send({
    t: 'hello',
    v: 1,
    title: 'Board',
    url: 'http://localhost:5173/',
    adapterVersion: 'test',
    policy: { invites: 'all' },
    resumeToken: token,
  });
  page.welcome = await page.next('welcome');
  // The welcome is the first frame the relay sends a page.
  return { page, welcomeBytes: sizes[0] ?? 0 };
}

describe('a roster at its largest (ADR 0044, A6.21)', () => {
  it(`fits the welcome under ${String(WELCOME_BOUND_BYTES)} bytes, an invitee's row listing ${String(MAX_ROSTER_CLIENTS_PER_INVITEE)} clients`, async () => {
    current = await startInviteRelay({
      limits: { usersPerPage: MAX_USERS_PER_PAGE, observersPerPage: MAX_OBSERVERS_PER_PAGE },
    });
    const first = await current.page({ policy: { invites: 'all' } });
    const pageId = first.pageId;
    const token = first.welcome?.resumeToken ?? '';
    const put = putWorstRoster(current.store, pageId, {
      members: MAX_USERS_PER_PAGE,
      invitees: MAX_OBSERVERS_PER_PAGE,
    });
    // The page sleeps, and its next welcome carries every row.
    first.ws.terminate();
    await first.closed;
    const { page, welcomeBytes } = await resume(current, token);
    current.pages.push(page);
    const welcome = page.welcome;
    expect(welcome?.resumed).toBe(true);
    const roster = welcome?.roster ?? [];
    expect(roster).toHaveLength(MAX_USERS_PER_PAGE + MAX_OBSERVERS_PER_PAGE);
    for (const row of roster) {
      const stored = put.find((attachment) => attachment.userId === row.userId);
      expect(stored?.clients).toHaveLength(ROSTER_CLIENTS);
      // Newest first, as the store keeps them, so the roster names who called last.
      const listed = row.kind === 'invitee' ? MAX_ROSTER_CLIENTS_PER_INVITEE : ROSTER_CLIENTS;
      expect(row.clients).toEqual(stored?.clients.slice(0, listed));
    }
    expect(welcomeBytes).toBeGreaterThan(MAX_FRAME_BYTES / 2);
    expect(welcomeBytes).toBeLessThan(WELCOME_BOUND_BYTES);

    // Every client listed, as before the cap, would pass the frame cap the adapter holds a welcome to.
    const uncapped: RelayFrame = {
      ...(welcome as Extract<RelayFrame, { t: 'welcome' }>),
      roster: roster.map((row) => ({
        ...row,
        clients: put.find((attachment) => attachment.userId === row.userId)?.clients ?? [],
      })),
    };
    expect(Buffer.byteLength(encodeFrame(uncapped), 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);
  });

  it("caps an invitee's row in every roster frame too, never a member's", async () => {
    current = await startInviteRelay();
    const page = await current.page({ policy: { invites: 'all' } });
    const [member, invitee] = putWorstRoster(current.store, page.pageId, {
      members: 1,
      invitees: 1,
    });
    // Any change sends the roster; a role switch the relay applies is one.
    page.send({ t: 'set_role', userId: member?.userId ?? '', role: 'driver' });
    await page.sync();
    const rows = page.all('roster').at(-1)?.attachments ?? [];
    expect(rows.find((row) => row.userId === member?.userId)?.clients).toHaveLength(ROSTER_CLIENTS);
    expect(rows.find((row) => row.userId === invitee?.userId)?.clients).toEqual(
      invitee?.clients.slice(0, MAX_ROSTER_CLIENTS_PER_INVITEE),
    );
  });
});
