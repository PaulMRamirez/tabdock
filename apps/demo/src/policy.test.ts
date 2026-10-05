import { describe, expect, it } from 'vitest';
import { linkPolicyFromQuery, policyFromQuery, policyNotes } from './policy.ts';

const read = (query: string) => policyFromQuery(new URLSearchParams(query));

describe('policyFromQuery', () => {
  it("keeps the adapter's defaults, Can watch invites and one driver, without ?invites", () => {
    expect(read('')).toEqual({ consequentialTools: ['clear_board'] });
    expect(read('?relay=wss://relay.example/page&e2e')).toEqual({
      consequentialTools: ['clear_board'],
    });
  });

  it('offers Can control invites and two driver seats with ?invites=all', () => {
    expect(read('?invites=all')).toEqual({
      consequentialTools: ['clear_board'],
      invites: 'all',
      maxDrivers: 2,
    });
  });

  it('offers no invites with ?invites=off, and reads anything else as the default', () => {
    expect(read('?invites=off')).toEqual({ consequentialTools: ['clear_board'], invites: 'off' });
    for (const value of ['watch', 'ALL', 'all ', '', 'everyone']) {
      expect(read(`?invites=${encodeURIComponent(value)}`), value).toEqual({
        consequentialTools: ['clear_board'],
      });
    }
  });

  it('lets member drivers confirm in their own client with ?confirm=client, beside ?invites', () => {
    expect(read('?confirm=client')).toEqual({
      consequentialTools: ['clear_board'],
      confirmVia: 'client',
    });
    expect(read('?invites=all&confirm=client')).toEqual({
      consequentialTools: ['clear_board'],
      confirmVia: 'client',
      invites: 'all',
      maxDrivers: 2,
    });
    for (const value of ['page', 'CLIENT', 'client ', '', 'operator']) {
      expect(read(`?confirm=${encodeURIComponent(value)}`), value).toEqual({
        consequentialTools: ['clear_board'],
      });
    }
  });

  it('names every departure from the defaults for the person at the tab, and none for the defaults', () => {
    const notes = (query: string) => policyNotes(linkPolicyFromQuery(new URLSearchParams(query)));
    expect(notes('')).toBe('');
    expect(notes('?confirm=page&invites=watch')).toBe('');
    expect(notes('?confirm=client&invites=all')).toBe(
      'members you approve confirm clear_board in their own MCP client, not on this board; the board offers Can control invites and a second driver seat.',
    );
    expect(notes('?invites=off')).toBe('the board offers no invites.');
  });
});
