// Each page's latest published state (ADR 0040): its canonical text, a
// version counted per page session, and the readers waiting on a change,
// kept out of hub.ts as confirm.ts keeps the questions in clients. It never
// logs a value.

import type { PagePart } from './page-parts.ts';

export class PageStates implements PagePart {
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
