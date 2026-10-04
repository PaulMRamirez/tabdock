import { AuditEventSchema } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  callRecords,
  createMemoryStore,
  type InviteRecord,
  type PageRecord,
  type SingleUseTicketRecord,
} from '../src/index.ts';

function pageRecord(pageId: string, resumeTokenHash: string): PageRecord {
  return {
    pageId,
    origin: 'http://localhost:5173',
    title: 't',
    url: 'http://localhost:5173/',
    adapterVersion: 'test',
    policy: {
      autoApprove: 'none',
      maxDrivers: 1,
      consequential: 'confirm',
      consequentialTools: [],
      invites: 'watch',
    },
    tools: [],
    toolsPending: false,
    state: 'awake',
    resumeTokenHash,
    connectedAt: 0,
    asleepAt: null,
    goneAt: null,
    formerAttachments: [],
  };
}

describe('the in-memory store', () => {
  it('forgets a resume token hash once the record moves on, even when mutated in place', () => {
    const { pages } = createMemoryStore();
    const page = pageRecord('pg_A', 'hash-1');
    pages.put(page);
    expect(pages.findByResumeTokenHash('hash-1')).toBe(page);
    page.resumeTokenHash = 'hash-2';
    pages.put(page);
    expect(pages.findByResumeTokenHash('hash-1')).toBeUndefined();
    expect(pages.findByResumeTokenHash('hash-2')).toBe(page);
    page.resumeTokenHash = '';
    pages.put(page);
    expect(pages.findByResumeTokenHash('hash-2')).toBeUndefined();
    expect(pages.findByResumeTokenHash('')).toBeUndefined();
    pages.delete('pg_A');
    expect(pages.get('pg_A')).toBeUndefined();
  });

  it('keeps one live ticket per page', () => {
    const { tickets } = createMemoryStore();
    const first = { pageId: 'pg_A', codeHash: Buffer.alloc(32, 1), expiresAt: 1 };
    const second = { pageId: 'pg_A', codeHash: Buffer.alloc(32, 2), expiresAt: 2 };
    tickets.put(first);
    tickets.put(second);
    expect(tickets.findByCodeHash(first.codeHash.toString('hex'))).toBeUndefined();
    expect(tickets.forPage('pg_A')).toBe(second);
    tickets.deleteForPage('pg_A');
    expect(tickets.findByCodeHash(second.codeHash.toString('hex'))).toBeUndefined();
  });

  it('indexes attachments by page and by user', () => {
    const { attachments } = createMemoryStore();
    const base = {
      displayName: 'x',
      kind: 'member' as const,
      role: 'observer' as const,
      grantedAt: 0,
      lastUsedAt: null,
      expiresAt: null,
      clients: [],
      inviteId: null,
      endsAt: null,
    };
    attachments.put({ ...base, pageId: 'pg_A', userId: 'alice' });
    attachments.put({ ...base, pageId: 'pg_A', userId: 'bob' });
    attachments.put({ ...base, pageId: 'pg_B', userId: 'alice' });
    expect(attachments.listForPage('pg_A').map((a) => a.userId)).toEqual(['alice', 'bob']);
    expect(attachments.listForUser('alice').map((a) => a.pageId)).toEqual(['pg_A', 'pg_B']);
    expect(attachments.delete('pg_A', 'alice')).toBe(true);
    expect(attachments.delete('pg_A', 'alice')).toBe(false);
    expect(attachments.listForUser('alice').map((a) => a.pageId)).toEqual(['pg_B']);
  });

  it('returns audit copies, so callers cannot rewrite history', () => {
    const { audit } = createMemoryStore();
    audit.append({
      v: 1,
      type: 'call',
      at: 1,
      pageId: 'pg_A',
      origin: null,
      userId: 'alice',
      client: { name: 'c', version: '1' },
      tool: 't',
      outcome: 'ok',
      durationMs: 0,
    });
    const [record] = callRecords(audit.records());
    if (record) {
      record.outcome = 'timeout';
      if (record.client) record.client.name = 'rewritten';
    }
    expect(callRecords(audit.records())[0]).toMatchObject({
      outcome: 'ok',
      client: { name: 'c' },
    });
  });

  it('keeps every audit record type and picks out the calls (ADR 0019)', () => {
    const { audit } = createMemoryStore();
    const call = {
      v: 1,
      type: 'call',
      at: 1,
      pageId: 'pg_A',
      origin: 'http://localhost:5173',
      userId: 'alice',
      client: null,
      tool: 't',
      outcome: 'ok',
      durationMs: 3,
    } as const;
    const detach = {
      v: 1,
      type: 'detach',
      at: 2,
      pageId: 'pg_A',
      origin: 'http://localhost:5173',
      userId: 'alice',
    } as const;
    audit.append(call);
    audit.append(detach);
    expect(audit.records()).toEqual([call, detach]);
    expect(callRecords(audit.records())).toEqual([call]);
    for (const event of audit.records()) expect(AuditEventSchema.parse(event)).toEqual(event);
  });

  it('keeps invites by page and id, finds them by digest, and forgets a digest it replaced', () => {
    const { invites } = createMemoryStore();
    const hash = (fill: string): string => fill.repeat(64);
    const invite = (pageId: string, inviteId: string, fill: string): InviteRecord => ({
      inviteId,
      pageId,
      role: 'observer',
      label: 'Friends',
      uses: 3,
      usesLeft: 3,
      createdAt: 0,
      requestedExpiresAt: null,
      expiresAt: 86_400_000,
      secretHash: hash(fill),
      sponsor: { userId: 'alice', displayName: 'Alice' },
      pendingRequestId: null,
      refusals: 0,
      barredUserIds: [],
      barredEmailHashes: [],
    });
    // Ids are the adapter's, so two pages may use the same one without meeting.
    invites.put(invite('pg_A', 'inv_1', 'a'));
    invites.put(invite('pg_A', 'inv_2', 'b'));
    invites.put(invite('pg_B', 'inv_1', 'c'));
    expect(invites.get('pg_A', 'inv_1')?.secretHash).toBe(hash('a'));
    expect(invites.get('pg_B', 'inv_1')?.secretHash).toBe(hash('c'));
    expect(invites.findBySecretHash(hash('c'))?.pageId).toBe('pg_B');
    expect(invites.listForPage('pg_A').map((entry) => entry.inviteId)).toEqual(['inv_1', 'inv_2']);
    // Replaced under a new digest, the old digest no longer finds it.
    invites.put({ ...invite('pg_A', 'inv_1', 'd'), usesLeft: 2 });
    expect(invites.findBySecretHash(hash('a'))).toBeUndefined();
    expect(invites.findBySecretHash(hash('d'))?.usesLeft).toBe(2);
    expect(invites.delete('pg_A', 'inv_1')).toBe(true);
    expect(invites.delete('pg_A', 'inv_1')).toBe(false);
    expect(invites.findBySecretHash(hash('d'))).toBeUndefined();
    // A page's invites go together and come back for their records; another page's stay.
    expect(invites.deleteForPage('pg_A').map((entry) => entry.inviteId)).toEqual(['inv_2']);
    expect(invites.findBySecretHash(hash('b'))).toBeUndefined();
    expect(invites.listForPage('pg_A')).toEqual([]);
    expect(invites.get('pg_B', 'inv_1')).toBeDefined();
  });

  it('keeps single-use tickets by digest and kind: found without using, taken once, gone with their page', () => {
    const { singleUse } = createMemoryStore();
    const ticket = (pageId: string, fill: number): SingleUseTicketRecord => ({
      kind: 'pair',
      secretHash: Buffer.alloc(32, fill),
      pageId,
      createdAt: fill,
      expiresAt: fill + 1,
    });
    const hex = (fill: number): string => Buffer.alloc(32, fill).toString('hex');
    singleUse.put(ticket('pg_A', 1));
    singleUse.put(ticket('pg_A', 2));
    singleUse.put(ticket('pg_B', 3));
    // Looking leaves it in place; taking removes it, so a second take finds nothing.
    expect(singleUse.find('pair', hex(1))?.createdAt).toBe(1);
    expect(singleUse.find('pair', hex(1))?.createdAt).toBe(1);
    expect(singleUse.take('pair', hex(1))?.createdAt).toBe(1);
    expect(singleUse.take('pair', hex(1))).toBeUndefined();
    expect(singleUse.find('pair', hex(1))).toBeUndefined();
    // A page's tickets go together, and another page's stay.
    singleUse.deleteForPage('pair', 'pg_A');
    expect(singleUse.find('pair', hex(2))).toBeUndefined();
    expect(singleUse.find('pair', hex(3))?.pageId).toBe('pg_B');
    // A ticket put again under the same digest replaces the old one, page and all.
    singleUse.put({ ...ticket('pg_C', 3), createdAt: 30 });
    singleUse.deleteForPage('pair', 'pg_B');
    expect(singleUse.find('pair', hex(3))?.createdAt).toBe(30);
    singleUse.deleteForPage('pair', 'pg_C');
    expect(singleUse.find('pair', hex(3))).toBeUndefined();
  });
});
