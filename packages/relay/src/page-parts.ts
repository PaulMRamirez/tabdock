// What M6 keeps per page beside the hub's own records: a page's published
// state (page-state.ts, ADR 0040), its proposals (proposals.ts, ADR 0042) and
// its agent tokens (agents.ts, ADR 0044). Each lives in a module of its own,
// as confirm.ts keeps the questions in clients, and hears of the page's life
// through one interface, so a page that sleeps, resumes or goes, an
// attachment that ends (S8) and a policy that narrows reach every part at the
// same step of the hub's own change, and none is forgotten at one of them.

import type { HubError } from './hub.ts';

export interface PagePart {
  /** The page's socket closed and it sleeps within its resume window; nothing reaches it meanwhile. */
  sleep(pageId: string): void;
  /** A resume replaced a live socket: the reloaded page knows nothing it held before. */
  resumed(pageId: string): void;
  /** The page is gone for good: forget it. */
  gone(pageId: string): void;
  /** These users' attachments to the page ended; whatever they hold there answers `outcome` now (S8). */
  attachmentsEnded(pageId: string, users: ReadonlySet<string>, outcome: HubError): void;
  /** What the page allows changed, as a time-boxed session's start or end narrows or widens it (ADR 0043). */
  policyChanged(pageId: string): void;
  /** The relay is shutting down: answer every waiter and stop every timer, writing no lines. */
  close(): void;
}

/** Every part, told of each change in the order they were given. */
export class PageParts implements PagePart {
  readonly #parts: readonly PagePart[];

  constructor(parts: readonly PagePart[]) {
    this.#parts = [...parts];
  }

  sleep(pageId: string): void {
    for (const part of this.#parts) part.sleep(pageId);
  }

  resumed(pageId: string): void {
    for (const part of this.#parts) part.resumed(pageId);
  }

  gone(pageId: string): void {
    for (const part of this.#parts) part.gone(pageId);
  }

  attachmentsEnded(pageId: string, users: ReadonlySet<string>, outcome: HubError): void {
    for (const part of this.#parts) part.attachmentsEnded(pageId, users, outcome);
  }

  policyChanged(pageId: string): void {
    for (const part of this.#parts) part.policyChanged(pageId);
  }

  close(): void {
    for (const part of this.#parts) part.close();
  }
}
