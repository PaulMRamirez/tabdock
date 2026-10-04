import { describe, expect, it } from 'vitest';
import { policyFromQuery } from './policy.ts';

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
});
