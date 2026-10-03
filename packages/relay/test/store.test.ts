import { describe, expect, it } from 'vitest';
import { createMemoryStore, type PageRecord, type SingleUseTicketRecord } from '../src/index.ts';

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
      role: 'observer' as const,
      grantedAt: 0,
      lastUsedAt: null,
      expiresAt: null,
      clients: [],
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
      at: 1,
      pageId: 'pg_A',
      origin: null,
      userId: 'alice',
      client: null,
      tool: 't',
      outcome: 'ok',
      durationMs: 0,
    });
    const [record] = audit.records();
    if (record) record.outcome = 'timeout';
    expect(audit.records()[0]?.outcome).toBe('ok');
  });

  it('keeps single-use tickets by digest and kind: found without using, taken once, gone with their page', () => {
    const { singleUse } = createMemoryStore();
    const ticket = (pageId: string, fill: number): SingleUseTicketRecord => ({
      kind: 'pair',
      secretHash: Buffer.alloc(32, fill),
      pageId,
      createdAt: 0,
      expiresAt: 1,
      traceId: `tr_${String(fill)}`,
    });
    const hex = (fill: number): string => Buffer.alloc(32, fill).toString('hex');
    singleUse.put(ticket('pg_A', 1));
    singleUse.put(ticket('pg_A', 2));
    singleUse.put(ticket('pg_B', 3));
    // Looking leaves it in place; taking removes it, so a second take finds nothing.
    expect(singleUse.find('pair', hex(1))?.traceId).toBe('tr_1');
    expect(singleUse.find('pair', hex(1))?.traceId).toBe('tr_1');
    expect(singleUse.take('pair', hex(1))?.traceId).toBe('tr_1');
    expect(singleUse.take('pair', hex(1))).toBeUndefined();
    expect(singleUse.find('pair', hex(1))).toBeUndefined();
    // A page's tickets go together, and another page's stay.
    singleUse.deleteForPage('pair', 'pg_A');
    expect(singleUse.find('pair', hex(2))).toBeUndefined();
    expect(singleUse.find('pair', hex(3))?.pageId).toBe('pg_B');
    // A ticket put again under the same digest replaces the old one, page and all.
    singleUse.put({ ...ticket('pg_C', 3), traceId: 'tr_again' });
    singleUse.deleteForPage('pair', 'pg_B');
    expect(singleUse.find('pair', hex(3))?.traceId).toBe('tr_again');
    singleUse.deleteForPage('pair', 'pg_C');
    expect(singleUse.find('pair', hex(3))).toBeUndefined();
  });
});
