// What a value the relay keeps holds on the heap, counted as it is kept: a
// listed tool's cut copy (hub.ts) and, from M6, a proposal's arguments and
// the outcome kept for it (ADR 0042). Each budget is charged from the tally,
// never from a frame's size on the wire (S9, ADR 0018), since the parsed
// copy, not the text it came from, is what stays.

/**
 * The values and object keys a kept copy holds, and the characters of every
 * string in it. limits.toolBytes is charged from this (heldBytes in hub.ts).
 */
export interface HeldTally {
  nodes: number;
  chars: number;
}

/** Counts a value the relay keeps as it is, such as a stub schema or a proposal's arguments. */
export function holdValue(value: unknown, tally: HeldTally): void {
  tally.nodes += 1;
  if (typeof value === 'string') tally.chars += value.length;
  else if (Array.isArray(value)) for (const item of value) holdValue(item, tally);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      tally.nodes += 1;
      tally.chars += key.length;
      holdValue(item, tally);
    }
  }
}
