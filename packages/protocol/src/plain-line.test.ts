// plainLine: self-declared text, a client's name above all, as the relay
// keeps it and the widget shows it, one line among the page's own words.

import { describe, expect, it } from 'vitest';
import { ClientInfoSchema, plainLine } from './index.ts';

describe('plainLine', () => {
  it('leaves plain text as it is, other scripts and emoji included', () => {
    expect(plainLine('claude-code 2.1.289')).toBe('claude-code 2.1.289');
    expect(plainLine('Claude f\u00fcr Desktop 0.12')).toBe('Claude f\u00fcr Desktop 0.12');
    expect(plainLine('\u05e2\u05d1\u05e8\u05d9\u05ea \u{1f600}')).toBe(
      '\u05e2\u05d1\u05e8\u05d9\u05ea \u{1f600}',
    );
  });

  it('drops the bidirectional controls, so a name cannot reverse the words after it', () => {
    for (const control of [
      '\u061c',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ]) {
      expect(plainLine(`claude-code ${control}2.1.289`)).toBe('claude-code 2.1.289');
    }
  });

  it('drops what shows as nothing: format characters, fillers, variation selectors, tags and a cut surrogate', () => {
    expect(plainLine('a\u00adb\u200bc\u200dd\u2060e\ufeff')).toBe('abcde');
    expect(plainLine('a\u3164b\u115fc\ufe0fd\u{e0041}e\u034ff')).toBe('abcdef');
    expect(plainLine(`${'a'.repeat(3)}\ud83d`)).toBe('aaa');
    expect(plainLine('\ude00b')).toBe('b');
  });

  it('makes each run of controls, spaces or breaks one space, so a name cannot start a line', () => {
    expect(plainLine(`Claude${'\u2003'.repeat(20)}09:41:07 Bob`)).toBe('Claude 09:41:07 Bob');
    expect(plainLine('a\u2028b\u2029c\nd\r\ne\tf\u0085g\u000bh\u000ci')).toBe('a b c d e f g h i');
    expect(plainLine('a\u0000\u0007\u001b[31mb\u007f\u009bc')).toBe('a [31mb c');
    expect(plainLine('a\u00a0\u3000\u2000\u200a\u202f\u205fb')).toBe('a b');
    expect(plainLine('  \u2003 a b \u2028 ')).toBe('a b');
  });

  it('never lengthens what it was given, so the caps still hold', () => {
    const name = `${'\u2003'.repeat(50)}x${'\u202e'.repeat(49)}`;
    expect(plainLine(name).length).toBeLessThanOrEqual(name.length);
    expect(ClientInfoSchema.safeParse({ name: plainLine(name), version: '' }).success).toBe(true);
  });

  it('can leave nothing at all', () => {
    expect(plainLine('\u202e\u200b \u2028')).toBe('');
  });
});
