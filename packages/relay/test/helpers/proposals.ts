// What the proposal tests share (ADR 0042): making a proposal as an observer
// would, reading and withdrawing it, the page's Accept and Dismiss, and
// numbered members and agents to fill rooms with.

import type { Client } from '@modelcontextprotocol/client';
import {
  agentKeyInput,
  type AuditEvent,
  type AuditEventOf,
  INVITEE_ID_PREFIX,
} from '@tabdock/protocol';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { ArgumentChecker } from '../../src/argument-checker.ts';
import type { AttachmentRecord, DevTokenUser, RelayStore } from '../../src/index.ts';
import type { RelayFrameOf, TestPage } from './page-client.ts';
import { callTool, type ToolOutcome } from './relay.ts';

/** add_item's arguments, as the test page's write tool takes them. */
export const ARGS = { label: 'Stop 3' };

/** An observer's write by call_page_tool: on a page that takes proposals, a proposal. */
export function propose(
  client: Client,
  page: string,
  args: Record<string, unknown> = ARGS,
  tool = 'add_item',
): Promise<ToolOutcome> {
  return callTool(client, 'call_page_tool', { page, tool, arguments: args });
}

/** The proposal id a proposed answer carries; throws on any other answer. */
export function proposalIdOf(outcome: ToolOutcome): string {
  const structured = outcome.structuredContent as { proposal?: unknown } | undefined;
  if (outcome.isError || typeof structured?.proposal !== 'string') {
    throw new Error(`not proposed: ${outcome.text}`);
  }
  return structured.proposal;
}

export interface ProposalRead {
  isError: boolean;
  text: string;
  structuredContent: unknown;
  /** The status word the answer starts with, or the error code. */
  head: string;
}

async function read(
  client: Client,
  name: 'get_proposal' | 'withdraw_proposal',
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ProposalRead> {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 60_000, ...(signal === undefined ? {} : { signal }) },
  );
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return {
    isError: result.isError === true,
    text,
    structuredContent: result.structuredContent,
    head: text.slice(0, text.indexOf(':')),
  };
}

export function getProposal(
  client: Client,
  page: string,
  proposal: string,
  waitMs?: number,
  signal?: AbortSignal,
): Promise<ProposalRead> {
  return read(
    client,
    'get_proposal',
    { page, proposal, ...(waitMs === undefined ? {} : { waitMs }) },
    signal,
  );
}

export function withdrawProposal(
  client: Client,
  page: string,
  proposal: string,
): Promise<ProposalRead> {
  return read(client, 'withdraw_proposal', { page, proposal });
}

/** The page's own answer to a proposal frame, and the relay has handled it once this resolves. */
export async function decide(
  page: TestPage,
  proposalId: string,
  accept: boolean,
  refused?: 'policy' | 'role' | 'tool' | 'consequential' | 'limit' | 'too_large',
): Promise<void> {
  page.send({
    t: 'proposal_decision',
    proposalId,
    accept,
    ...(refused === undefined ? {} : { refused }),
  });
  await page.sync();
}

/** The next proposal frame the page receives. */
export function nextProposal(page: TestPage): Promise<RelayFrameOf<'proposal'>> {
  return page.next('proposal');
}

/** A member with a dev token, numbered so a test can fill a room. */
export function member(n: number): DevTokenUser {
  return {
    userId: `member${String(n)}`,
    displayName: `Member ${String(n)}`,
    token: `member-${String(n)}-dev-token-3c7e9a1f5b2d8064`,
  };
}

/** The id ADR 0044 gives an agent token's caller on this page. */
export function agentUserId(pageId: string, tokenId: string): string {
  const hash = createHash('sha256').update(agentKeyInput(pageId, tokenId), 'utf8').digest('hex');
  return `${INVITEE_ID_PREFIX}${hash.slice(0, 32)}`;
}

/**
 * An agent token's attachment as ADR 0044's approval makes it, put straight
 * into the store, with a dev token for its id so a test can call as it.
 */
export function agentAttached(store: RelayStore, pageId: string, tokenId: string): DevTokenUser {
  const userId = agentUserId(pageId, tokenId);
  const attachment: AttachmentRecord = {
    pageId,
    userId,
    displayName: 'agent 0000',
    kind: 'invitee',
    role: 'observer',
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: tokenId,
    endsAt: Date.now() + 60 * 60_000,
    inviteRole: 'observer',
    sponsorId: 'alice',
    emailHash: null,
  };
  store.attachments.put(attachment);
  return {
    userId,
    displayName: 'agent',
    token: `agent-${tokenId}-dev-token-9d4b2e6a1c8f7350`,
    kind: 'invitee',
  };
}

/** The proposal_closed records written so far. */
export function closedLines(events: AuditEvent[]): AuditEventOf<'proposal_closed'>[] {
  return events.filter(
    (event): event is AuditEventOf<'proposal_closed'> => event.type === 'proposal_closed',
  );
}

/** The call records naming a proposal. */
export function proposalCalls(events: AuditEvent[], proposalId: string): AuditEventOf<'call'>[] {
  return events.filter(
    (event): event is AuditEventOf<'call'> =>
      event.type === 'call' && event.proposalId === proposalId,
  );
}

/** A step in the relay held until a test releases it. */
export interface Hold {
  /** Resolves once the relay waits on the held step. */
  started: Promise<void>;
  release: () => void;
}

/**
 * Holds the relay's argument check of the next call to `tool` until
 * released, so a test lands a revoke and a fresh approval exactly while
 * #propose waits on its worker, however quick the check would be. The
 * caller restores the spy (vi.restoreAllMocks).
 */
export function holdCheck(tool: string): Hold {
  let started: () => void = () => undefined;
  let release: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Called below with the relay's own checker as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const check = ArgumentChecker.prototype.check;
  let held = false;
  vi.spyOn(ArgumentChecker.prototype, 'check').mockImplementation(async function (
    this: ArgumentChecker,
    name,
    schema,
    args,
  ) {
    if (name === tool && !held) {
      held = true;
      started();
      await gate;
    }
    return check.call(this, name, schema, args);
  });
  return { started: begun, release };
}
