// Each page's agent tokens (ADR 0044): bearer credentials for /g/mcp that
// watch one page while a member sponsors them, kept only as digests and
// closed with the page, their sponsor or a time-boxed session's end. Neither
// a token nor its digest ever reaches a line or a record.

import type { AuditEventOf } from '@tabdock/protocol';
import type { PagePart } from './page-parts.ts';

/** Why a token stopped being live, as its agent_closed record names it. */
export type AgentCloseReason = AuditEventOf<'agent_closed'>['reason'];

export class AgentTokens implements PagePart {
  // M6 seam: not built. It holds nothing yet, so no change to a page has
  // anything here to end; the PagePart methods take no arguments until then.

  /**
   * Closes every live token of the page for one reason, as a page's end,
   * Revoke all or a time-boxed session's end does (ADR 0043's C11), and
   * says how many.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- holds nothing to close until ADR 0044's tokens
  closePage(_pageId: string, _reason: AgentCloseReason): number {
    // M6 seam: not built. W2-D closes the page's live tokens here.
    return 0;
  }

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
