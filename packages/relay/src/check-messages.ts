// Messages between the relay's main thread and its argument check worker
// (ADR 0010). Each side validates what it receives with these schemas, as at
// every other boundary: the worker runs code that page schemas and client
// arguments steer, so its replies are input like any other. Relay-internal, so
// they live here rather than in packages/protocol, like AuthExtraSchema.

import { z } from 'zod';

/** sha256 of the prepared schema text, in hex. */
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Per-call ids from the main thread; they never repeat within one relay. */
const CheckIdSchema = z.number().int().nonnegative();
/** WebMCP's tool name length; the page link checked the name itself already. */
const MAX_TOOL_NAME_CHARS = 128;
/**
 * Relay-written failure text is a fixed prefix, a tool name, a location cut to
 * 200 characters and a fixed rule description; this leaves room to spare.
 */
const MAX_FAILURE_CHARS = 1000;

export const CheckRequestSchema = z.object({
  t: z.literal('check'),
  id: CheckIdSchema,
  tool: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
  hash: HashSchema,
  /** The prepared schema as JSON text; compiled only when the worker does not hold its hash. */
  schema: z.string(),
  /** The call's arguments as JSON text: copying one string costs the main thread far less than a structured clone. */
  args: z.string(),
});
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const CheckResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('valid') }),
  z.object({ kind: z.literal('invalid'), message: z.string().min(1).max(MAX_FAILURE_CHARS) }),
  /** CfWorker refused the schema; calls to the tool go unchecked from now on. */
  z.object({ kind: z.literal('uncompilable') }),
  /** The validator threw on these arguments, so they go on unchecked. */
  z.object({ kind: z.literal('failed') }),
]);
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const WorkerMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('result'), id: CheckIdSchema, result: CheckResultSchema }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
