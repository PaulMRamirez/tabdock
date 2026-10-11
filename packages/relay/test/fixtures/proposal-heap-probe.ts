// node --expose-gc proposal-heap-probe.ts <shape> <count>: keeps that many
// proposals of one shape in a PageProposals, each with arguments parsed from
// JSON as the relay's request parsing makes them (or, for the result shapes,
// an accepted run's text as a result frame's parsing makes it), and prints
// as one JSON line the heap each holds beside what it was charged against
// limits.proposalBytes. proposal-heap.test.ts runs it, since only a process
// started with --expose-gc can collect garbage on demand and measure what
// stays.

import { MAX_PROPOSAL_ARGUMENT_BYTES, MAX_PROPOSAL_RESULT_CHARS } from '@tabdock/protocol';
import type { CallerIdentity } from '../../src/hub.ts';
import { PageProposals, proposalCharge } from '../../src/proposals.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');

/** {"label":"…"} is 12 bytes around its text. */
const ROOM = MAX_PROPOSAL_ARGUMENT_BYTES - 12;

/** Argument shapes at the caps, each holding the most of one kind, as JSON text. */
const SHAPES: Record<string, (n: number) => string> = {
  /** One byte a character: the most characters. */
  ascii: (n) => JSON.stringify({ label: `${String(n).padStart(6, '0')}${'a'.repeat(ROOM - 6)}` }),
  /** Characters past Latin-1, which V8 keeps at two bytes each. */
  twoByte: (n) =>
    JSON.stringify({ label: `${String(n).padStart(6, '0')}${'Ā'.repeat((ROOM - 6) / 2)}` }),
  /** The most values: an array of 995 small numbers, at the node cap. */
  nodes: (n) => JSON.stringify({ label: String(n), n: Array.from({ length: 995 }, (_, i) => i) }),
  /** The most keys: an object of 497 one-key entries, at the node cap. */
  keys: (n) => {
    const value: Record<string, unknown> = { label: String(n) };
    for (let key = 0; key < 497; key += 1) value[`k${key.toString(36)}`] = key;
    return JSON.stringify(value);
  },
  /** Next to nothing: what a proposal costs besides its values. */
  tiny: (n) => JSON.stringify({ label: String(n) }),
};

/** Result texts at the cut, kept for a proposer once its run settled. */
const RESULTS: Record<string, (n: number) => string> = {
  resultAscii: (n) =>
    JSON.stringify(`${String(n).padStart(6, '0')}${'r'.repeat(MAX_PROPOSAL_RESULT_CHARS - 6)}`),
  resultTwoByte: (n) =>
    JSON.stringify(`${String(n).padStart(6, '0')}${'Ā'.repeat(MAX_PROPOSAL_RESULT_CHARS - 6)}`),
};

const shape = process.argv[2] ?? 'ascii';
const count = Number(process.argv[3] ?? 200);
const makeArgs = SHAPES[shape] ?? SHAPES.tiny;
const makeResult = RESULTS[shape];
if (makeArgs === undefined) throw new Error(`no shape ${shape}`);

const proposals = new PageProposals({
  ttlMs: 600_000,
  budgetBytes: Number.MAX_SAFE_INTEGER,
  ended: () => undefined,
  admitted: () => true,
});

async function settle(): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 6; round += 1) {
    collect?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    least = Math.min(least, process.memoryUsage().heapUsed);
  }
  return least;
}

function keep(n: number, argsText: string): void {
  const args = JSON.parse(argsText) as Record<string, never>;
  // Each proposal's own caller, as each request makes one.
  const proposer: CallerIdentity = JSON.parse(
    JSON.stringify({
      userId: `user${String(n)}`,
      displayName: `User ${String(n)}`,
      account: { kind: 'member', email: null },
      oauthClientId: null,
      client: { name: 'probe', version: '1.0.0' },
      agentPageId: null,
    }),
  ) as CallerIdentity;
  const reservation = proposals.reserve(
    `pg_${String(n)}`,
    proposer.userId,
    proposalCharge(args),
    Date.now(),
  );
  if (typeof reservation === 'string') throw new Error(`refused: ${reservation}`);
  const record = proposals.commit(reservation, {
    proposalId: `pr_${String(n).padStart(10, '0')}`,
    origin: 'http://localhost:5173',
    proposer,
    grantedAt: Date.now(),
    tool: 'add_item',
    args,
    createdAt: Date.now(),
  });
  if (makeResult !== undefined) {
    proposals.accept(record);
    proposals.settleRun(record, 'ok', {
      text: JSON.parse(results[n] ?? '""') as string,
      image: false,
    });
  }
}

// One proposal first, so what the first costs once (maps, code) is in the baseline.
const texts = Array.from({ length: count + 1 }, (_, n) => makeArgs(n));
const results =
  makeResult === undefined ? [] : Array.from({ length: count + 1 }, (_, n) => makeResult(n));
keep(0, texts[0] ?? '{}');
const before = await settle();
const chargedBefore = proposals.held;
for (let n = 1; n <= count; n += 1) keep(n, texts[n] ?? '{}');
const after = await settle();
const charged = proposals.held;
process.stdout.write(
  `${JSON.stringify({
    shape,
    heapPerProposal: Math.round((after - before) / count),
    chargedPerProposal: Math.round((charged - chargedBefore) / count),
    // Kept alive past the last reading, so the texts are in both and only what the proposals keep is measured.
    texts: texts.length + results.length,
  })}\n`,
);
proposals.close();
process.exit(0);
