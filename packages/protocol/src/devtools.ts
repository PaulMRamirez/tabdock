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
  /** 1 for an element, 3 for text, 4 for a CDATA section, and so on, as the DOM numbers them. */
  nodeType?: number | undefined;
  /** A text node's text; empty for an element. */
  nodeValue?: string | undefined;
  localName?: string | undefined;
  /** Names and values in turn, so always an even count. */
  attributes?: string[] | undefined;
  children?: DevToolsNode[] | undefined;
  shadowRoots?: DevToolsNode[] | undefined;
  shadowRootType?: 'user-agent' | 'open' | 'closed' | undefined;
  contentDocument?: DevToolsNode | undefined;
}

const NodeIdSchema = z.number().check(z.int(), z.nonnegative());

/**
 * Well above what DevTools sends: it cuts a text node's value at 10,000
 * characters and adds an ellipsis, and a page's own long script or style
 * text must never make the whole tree unreadable.
 */
const MAX_NODE_VALUE_CHARS = 65_536;

export const DevToolsNodeSchema: z.ZodMiniType<DevToolsNode> = z.object({
  backendNodeId: NodeIdSchema,
  nodeType: z.optional(z.number().check(z.int(), z.nonnegative())),
  // The helper reads the widget's text from here rather than by running a
  // function on a node: that runs in the page's own world, where a getter a
  // later script patched would be handed the widget's node (ADR 0041).
  nodeValue: z.optional(z.string().check(z.maxLength(MAX_NODE_VALUE_CHARS))),
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

/**
 * DOM.resolveNode. The helper no longer resolves nodes: a function run on one
 * runs in the page's own world, so a prototype a later script patched is
 * handed the node, and through it the closed shadow root.
 */
export const DevToolsRemoteObjectSchema = z.object({
  object: z.object({ objectId: z.optional(z.string().check(z.maxLength(256))) }),
});
export type DevToolsRemoteObject = z.infer<typeof DevToolsRemoteObjectSchema>;

/** Runtime.callFunctionOn with returnByValue; the helper no longer calls it, as above. */
export const DevToolsCallResultSchema = z.object({
  result: z.object({ value: z.optional(z.unknown()) }),
  exceptionDetails: z.optional(z.object({ text: z.string() })),
});
export type DevToolsCallResult = z.infer<typeof DevToolsCallResultSchema>;
