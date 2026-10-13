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

// Four x, y pairs, corner by corner.
const QuadSchema = z.array(z.number()).check(z.length(8));

/**
 * DOM.getBoxModel: the content quad, whose centre the helper presses, and the
 * border quad, the area a hit test counts as the element.
 */
export const DevToolsBoxModelSchema = z.object({
  model: z.object({ content: QuadSchema, border: QuadSchema }),
});
export type DevToolsBoxModel = z.infer<typeof DevToolsBoxModelSchema>;

/** DOM.getNodeForLocation: the node a hit test found. */
export const DevToolsNodeAtSchema = z.object({ backendNodeId: NodeIdSchema });
export type DevToolsNodeAt = z.infer<typeof DevToolsNodeAtSchema>;

// z.number() takes no NaN or Infinity, so every offset here is a real place.
const CssSizeSchema = z.number().check(z.nonnegative());

/**
 * Page.getLayoutMetrics, in CSS pixels: where the visual viewport sits in the
 * document and how much of it shows, with the layout viewport's position and
 * the scrollable size beside it. DOM.getBoxModel and Input.dispatchMouseEvent
 * count from the visual viewport's corner, while DOM.getNodeForLocation counts
 * from the document's, so the helper adds pageX and pageY to hit-test the very
 * point it will press on a scrolled page. pageX is negative on a right-to-left
 * page scrolled left.
 */
export const DevToolsLayoutMetricsSchema = z.object({
  cssLayoutViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: CssSizeSchema,
    clientHeight: CssSizeSchema,
  }),
  cssVisualViewport: z.object({
    offsetX: z.number(),
    offsetY: z.number(),
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: CssSizeSchema,
    clientHeight: CssSizeSchema,
  }),
  cssContentSize: z.object({ width: CssSizeSchema, height: CssSizeSchema }),
});
export type DevToolsLayoutMetrics = z.infer<typeof DevToolsLayoutMetricsSchema>;
