// Each page's agent tokens (ADR 0044): bearer credentials for /g/mcp that
// watch one page while a member sponsors them, kept only as digests and
// closed with the page, their sponsor or a time-boxed session's end. Neither
// a token nor its digest ever reaches a line or a record.

import type { PagePart } from './page-parts.ts';

export class AgentTokens implements PagePart {
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
