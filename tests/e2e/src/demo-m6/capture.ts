// Leg 2 of pnpm demo:m6 (ADR 0039): Claude asks for capture_view, which the
// page declares an image tool; the PNG the client receives is saved to a
// file in the run's private directory, and its SHA-256 is the one the
// relay's audit line for that call records, beside its type and size, while
// the image itself never reaches the log.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstText,
  imageBytes,
  imagePart,
  pngDimensions,
  type ResultContent,
} from '../image-helpers.ts';
import { auditLines, bind, type Lesson } from './lesson.ts';

export async function capture(lesson: Lesson): Promise<void> {
  const { say, check } = bind(lesson.narrator);
  say(
    `tools/call call_page_tool { page: "${lesson.pageId}", tool: "capture_view", arguments: { maxWidthPx: 480, format: "png" } }`,
  );
  const result = (await lesson.alice.callTool(
    {
      name: 'call_page_tool',
      arguments: {
        page: lesson.pageId,
        tool: 'capture_view',
        arguments: { maxWidthPx: 480, format: 'png' },
      },
    },
    { timeout: 60_000 },
  )) as ResultContent;
  const [label = '', imageLine = ''] = firstText(result).split('\n');
  say(`   ${label}`);
  say(`   ${imageLine.slice(0, 150)}`);
  check(result.isError !== true, 'capture_view should answer with an image');
  check(
    result.structuredContent === undefined,
    'an image answer carries no structured content (S10)',
  );
  const image = imagePart(result);
  if (image === null) throw new Error('capture_view answered with no image');
  const bytes = imageBytes(image);
  const size = pngDimensions(bytes);
  const file = join(lesson.scratch, 'capture-view.png');
  writeFileSync(file, bytes, { mode: 0o600 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  say(
    `   The client got one ${image.mimeType}, ${String(bytes.length)} bytes, ${String(size?.width ?? 0)} by ${String(size?.height ?? 0)} px, saved to ${file}`,
  );
  say(`   sha256 of the file:      ${digest}`);
  const line = auditLines(lesson.room.auditDir)
    .filter((record) => record.type === 'call' && record.tool === 'capture_view')
    .at(-1);
  const audited = line?.type === 'call' ? line.image : undefined;
  say(`   sha256 in the audit line: ${audited?.sha256 ?? '(none)'}`);
  say(
    `   The audit line: call ${line?.type === 'call' ? line.outcome : '?'}, ${audited?.mimeType ?? '?'}, ${String(audited?.bytes ?? 0)} bytes, never the image.`,
  );
  check(audited?.sha256 === digest, "the audit line's SHA-256 should be the saved file's");
  check(audited?.bytes === bytes.length, "the audit line's size should be the saved file's");
}
