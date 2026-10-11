// The session record in a real browser (ADR 0045): a Tabdock relay that
// keeps a hash-chained audit directory, beside the demo board; the
// operator's Save from the widget's record box or from a session's offer,
// each a trusted click on an armed box, read back as the file the browser
// downloaded; and `pnpm audit:log --match` on that file, run as the owner
// runs it. Shared by specs/session-record.spec.ts, later-scripts.spec.ts and
// the demo's record leg.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Download, Page } from '@playwright/test';
import type { RecordWhich } from '@tabdock/adapter';
import type { DemoServer } from '@tabdock/demo/server';
import { createDevTokenAuth, createRelay, type LogSink } from '@tabdock/relay';
import { readAuditLines } from '../../../packages/relay/src/audit-file.ts';
import {
  clickInWidget,
  demoPageUrl,
  type Tabdock,
  throwawayUser,
  widgetButtonNow,
  widgetVisible,
} from './tabdock-harness.ts';

/** The reader as `pnpm audit:log` runs it in a checkout. */
const AUDIT_CLI = fileURLToPath(
  new URL('../../../packages/relay/src/audit-cli.ts', import.meta.url),
);

export interface AuditedTabdock extends Tabdock {
  /** The relay's audit directory, removed on close. */
  readonly auditDir: string;
}

/**
 * startTabdock's relay with an audit directory of its own (ADR 0019), so a
 * record saved from the widget can be held to the log it wrote.
 */
export async function startAuditedTabdock(
  demo: DemoServer,
  options: { logSink?: LogSink } = {},
): Promise<AuditedTabdock> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-record-')));
  const auditDir = join(scratch, 'audit');
  const users = { alice: throwawayUser('alice', 'Alice'), bob: throwawayUser('bob', 'Bob') };
  const relay = await createRelay({
    auth: createDevTokenAuth([users.alice, users.bob]),
    port: 0,
    // A real browser always sends Origin; the dev default allows 127.0.0.1 at any port.
    allowMissingOrigin: false,
    logSink: options.logSink ?? (() => undefined),
    audit: { dir: auditDir },
  });
  return {
    relay,
    demo,
    users,
    auditDir,
    pageUrl: demoPageUrl(demo, relay.pageUrl),
    async close() {
      await relay.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** A file the browser saved from the widget: the name it suggested, where it landed, and its text. */
export interface SavedFile {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

async function read(download: Download): Promise<SavedFile> {
  const path = await download.path();
  return { name: download.suggestedFilename(), path, text: readFileSync(path, 'utf8') };
}

/** Opens the panel, then the record box with Save record, unless either is open already. */
export async function openRecordBox(page: Page): Promise<void> {
  if (!(await widgetVisible(page, 'record-summary'))) {
    await clickInWidget(page, { action: 'toggle' });
  }
  if ((await widgetButtonNow(page, { action: 'record-save-json' })) === null) {
    await clickInWidget(page, { action: 'record-open' });
  }
}

/**
 * Saves a record from the widget's box as the operator does: Save record,
 * the record chosen when the box offers more than one, then Save JSON or
 * Save summary once the box has held still, inside the download it starts.
 */
export async function saveRecordFromWidget(
  page: Page,
  kind: 'json' | 'md',
  which?: RecordWhich,
): Promise<SavedFile> {
  await openRecordBox(page);
  if (which !== undefined) await clickInWidget(page, { action: `record-which-${which}` });
  const download = page.waitForEvent('download');
  await clickInWidget(page, { action: kind === 'json' ? 'record-save-json' : 'record-save-md' });
  return read(await download);
}

/** Saves the record a session's end offers, the offer being the only box with a Save then. */
export async function saveOfferedRecord(page: Page, kind: 'json' | 'md'): Promise<SavedFile> {
  const download = page.waitForEvent('download');
  await clickInWidget(page, { action: kind === 'json' ? 'record-save-json' : 'record-save-md' });
  return read(await download);
}

/** `pnpm audit:log --match <file> --verify` against `auditDir`, as a process of its own. */
export function auditMatch(
  file: string,
  auditDir: string,
): { code: number | null; out: string; err: string } {
  const run = spawnSync(
    process.execPath,
    [AUDIT_CLI, '--match', file, '--dir', auditDir, '--verify'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return { code: run.status, out: run.stdout, err: run.stderr };
}

/** The callIds of the call lines the relay wrote, in the log's order: each an invoke that went out. */
export function auditedCallIds(auditDir: string): string[] {
  return [...readAuditLines(auditDir)].flatMap((line) =>
    line.record?.type === 'call' && line.record.callId !== undefined ? [line.record.callId] : [],
  );
}
