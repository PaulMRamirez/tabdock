import { describe, expect, it } from 'vitest';
import { busyFromQuery } from './busy.ts';

const read = (query: string) => busyFromQuery(new URLSearchParams(query));

describe('busyFromQuery', () => {
  it('is off without ?busy', () => {
    expect(read('')).toBeNull();
    expect(read('?relay=ws://127.0.0.1:8787/page&e2e')).toBeNull();
  });

  it('spins half the time in a worker by default', () => {
    expect(read('?busy')).toEqual({ share: 50, where: 'worker' });
    expect(read('?busy=')).toEqual({ share: 50, where: 'worker' });
  });

  it('takes a share from 1 to 100, and a timer on the page with busyIn=main', () => {
    expect(read('?busy=1')).toEqual({ share: 1, where: 'worker' });
    expect(read('?busy=100&busyIn=main')).toEqual({ share: 100, where: 'main' });
    expect(read('?busy=30&busyIn=elsewhere')).toEqual({ share: 30, where: 'worker' });
  });

  it('ignores anything else rather than spinning by surprise', () => {
    for (const value of ['0', '101', '-5', '2.5', 'lots', '1000']) {
      expect(read(`?busy=${value}`), value).toBeNull();
    }
  });
});
