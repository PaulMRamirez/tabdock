// Each page's proposals from observers (ADR 0042): pending ones waiting for
// the operator, the outcomes kept for their proposers, and the relay-wide
// charge limits.proposalBytes bounds, kept out of hub.ts as confirm.ts keeps
// the questions in clients. It never logs arguments or results.

import type { PagePart } from './page-parts.ts';

export class PageProposals implements PagePart {
  // M6 seam: not built. It holds nothing yet, so no change to a page has
  // anything here to end; the PagePart methods take no arguments until then.
  sleep(): void {
    // Nothing held.
  }

  resumed(): void {
    // Nothing held.
  }

  gone(): void {
    // Nothing held.
  }

  attachmentsEnded(): void {
    // Nothing held.
  }

  policyChanged(): void {
    // Nothing held.
  }

  close(): void {
    // Nothing held.
  }
}
