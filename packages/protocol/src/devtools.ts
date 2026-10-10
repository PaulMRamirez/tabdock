// Replies from the Chrome DevTools protocol that ADR 0041's helper
// (@tabdock/adapter/testing) reads while it finds the widget's pairing code
// and clicks Allow with trusted input. A browser test hands the helper any
// DevTools session, so every reply it acts on is checked here first: a
// malformed reply stops the helper rather than steering a click. Unknown keys
// are dropped, since Chromium adds fields over time.
//
// This module is exported only at the `./devtools` subpath, never from the
// package's index: the relay and the adapter's page build have no use for it,
// and it must add nothing to either.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';

/** A node of DOM.getDocument's tree, as deep as the helper asks for. */
export interface DevToolsNode {
  backendNodeId: number;
  localName?: string | undefined;
  /** Names and values in turn, so always an even count. */
  attributes?: string[] | undefined;
  children?: DevToolsNode[] | undefined;
  shadowRoots?: DevToolsNode[] | undefined;
  shadowRootType?: 'user-agent' | 'open' | 'closed' | undefined;
  contentDocument?: DevToolsNode | undefined;
}

const NodeIdSchema = z.number().check(z.int(), z.nonnegative());

export const DevToolsNodeSchema: z.ZodMiniType<DevToolsNode> = z.object({
  backendNodeId: NodeIdSchema,
  localName: z.optional(z.string().check(z.maxLength(256))),
  attributes: z.optional(
    z.array(z.string()).check(
      z.refine((names) => names.length % 2 === 0, {
        message: 'attributes come in name and value pairs',
      }),
    ),
  ),
  get children() {
    return z.optional(z.array(DevToolsNodeSchema));
  },
  get shadowRoots() {
    return z.optional(z.array(DevToolsNodeSchema));
  },
  shadowRootType: z.optional(z.enum(['user-agent', 'open', 'closed'])),
  get contentDocument() {
    return z.optional(DevToolsNodeSchema);
  },
});

/** DOM.getDocument. */
export const DevToolsDocumentSchema = z.object({ root: DevToolsNodeSchema });
export type DevToolsDocument = z.infer<typeof DevToolsDocumentSchema>;

/** DOM.getBoxModel: the content quad as four x, y pairs. */
export const DevToolsBoxModelSchema = z.object({
  model: z.object({ content: z.array(z.number()).check(z.length(8)) }),
});
export type DevToolsBoxModel = z.infer<typeof DevToolsBoxModelSchema>;

/** DOM.getNodeForLocation: the node a hit test found. */
export const DevToolsNodeAtSchema = z.object({ backendNodeId: NodeIdSchema });
export type DevToolsNodeAt = z.infer<typeof DevToolsNodeAtSchema>;

/** DOM.resolveNode. */
export const DevToolsRemoteObjectSchema = z.object({
  object: z.object({ objectId: z.optional(z.string().check(z.maxLength(256))) }),
});
export type DevToolsRemoteObject = z.infer<typeof DevToolsRemoteObjectSchema>;

/** Runtime.callFunctionOn with returnByValue. */
export const DevToolsCallResultSchema = z.object({
  result: z.object({ value: z.optional(z.unknown()) }),
  exceptionDetails: z.optional(z.object({ text: z.string() })),
});
export type DevToolsCallResult = z.infer<typeof DevToolsCallResultSchema>;
