// ADR 0041's DevTools reply schemas: each takes a reply as Chromium sends
// it and refuses the malformed ones the helper must never act on; the module
// is reachable at its own subpath, in the workspace and once packed, and
// nowhere else.

import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import * as exported from './index.ts';
import {
  DevToolsBoxModelSchema,
  DevToolsCallResultSchema,
  DevToolsDocumentSchema,
  type DevToolsNode,
  DevToolsNodeAtSchema,
  DevToolsNodeSchema,
  DevToolsRemoteObjectSchema,
} from './devtools.ts';

/** DOM.getDocument with depth -1 and pierce true, cut down from Chromium 155 on the demo board. */
const DOCUMENT = {
  root: {
    nodeId: 1,
    backendNodeId: 3,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    nodeValue: '',
    childNodeCount: 2,
    children: [
      { nodeId: 2, parentId: 1, backendNodeId: 4, nodeType: 10, nodeName: 'html', localName: '' },
      {
        nodeId: 3,
        parentId: 1,
        backendNodeId: 5,
        nodeType: 1,
        nodeName: 'HTML',
        localName: 'html',
        attributes: ['lang', 'en'],
        children: [
          {
            nodeId: 9,
            backendNodeId: 12,
            nodeType: 1,
            nodeName: 'TABDOCK-DOCK',
            localName: 'tabdock-dock',
            attributes: [],
            shadowRoots: [
              {
                nodeId: 10,
                backendNodeId: 13,
                nodeType: 11,
                nodeName: '#document-fragment',
                localName: '',
                shadowRootType: 'closed',
                children: [
                  {
                    nodeId: 11,
                    backendNodeId: 14,
                    nodeType: 1,
                    nodeName: 'SPAN',
                    localName: 'span',
                    attributes: ['data-role', 'pairing-code'],
                    children: [
                      {
                        nodeId: 12,
                        backendNodeId: 15,
                        nodeType: 3,
                        nodeName: '#text',
                        localName: '',
                        nodeValue: 'ABCD',
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            nodeId: 20,
            backendNodeId: 30,
            nodeType: 1,
            nodeName: 'IFRAME',
            localName: 'iframe',
            attributes: ['src', 'about:blank'],
            contentDocument: {
              nodeId: 21,
              backendNodeId: 31,
              nodeType: 9,
              nodeName: '#document',
              localName: '',
            },
          },
        ],
      },
    ],
  },
};

const BOX_MODEL = {
  model: {
    content: [100, 200, 180, 200, 180, 232, 100, 232],
    padding: [96, 196, 184, 196, 184, 236, 96, 236],
    border: [96, 196, 184, 196, 184, 236, 96, 236],
    margin: [96, 196, 184, 196, 184, 236, 96, 236],
    width: 88,
    height: 40,
  },
};

describe('the DevTools reply schemas', () => {
  it('take replies as Chromium sends them, dropping fields the helper does not read', () => {
    const document = DevToolsDocumentSchema.parse(DOCUMENT);
    const host = document.root.children?.[1]?.children?.[0];
    expect(host?.localName).toBe('tabdock-dock');
    expect(host?.shadowRoots?.[0]?.shadowRootType).toBe('closed');
    expect(host?.shadowRoots?.[0]?.children?.[0]?.attributes).toEqual([
      'data-role',
      'pairing-code',
    ]);
    expect(document.root.children?.[1]?.children?.[1]?.contentDocument?.backendNodeId).toBe(31);
    expect(JSON.stringify(document)).not.toContain('nodeValue');
    expect(DevToolsBoxModelSchema.parse(BOX_MODEL)).toEqual({
      model: { content: BOX_MODEL.model.content },
    });
    expect(DevToolsNodeAtSchema.parse({ backendNodeId: 14, frameId: 'F1', nodeId: 0 })).toEqual({
      backendNodeId: 14,
    });
    const remote = {
      object: {
        type: 'object',
        subtype: 'node',
        className: 'HTMLButtonElement',
        objectId: '-123.4.5',
      },
    };
    expect(DevToolsRemoteObjectSchema.parse(remote)).toEqual({ object: { objectId: '-123.4.5' } });
    expect(DevToolsRemoteObjectSchema.parse({ object: { type: 'undefined' } })).toEqual({
      object: {},
    });
    expect(
      DevToolsCallResultSchema.parse({ result: { type: 'string', value: 'ABCD-1234' } }),
    ).toEqual({
      result: { value: 'ABCD-1234' },
    });
    const thrown = {
      result: { type: 'object' },
      exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0 },
    };
    expect(DevToolsCallResultSchema.parse(thrown)).toEqual({
      result: {},
      exceptionDetails: { text: 'Uncaught' },
    });
  });

  it('refuse what the helper must never act on', () => {
    expect(DevToolsNodeSchema.safeParse({ backendNodeId: '14' }).success).toBe(false);
    expect(DevToolsNodeSchema.safeParse({ backendNodeId: -1 }).success).toBe(false);
    expect(DevToolsNodeSchema.safeParse({ backendNodeId: 1.5 }).success).toBe(false);
    expect(
      DevToolsNodeSchema.safeParse({ backendNodeId: 1, attributes: ['data-role'] }).success,
    ).toBe(false);
    expect(
      DevToolsNodeSchema.safeParse({ backendNodeId: 1, localName: 'x'.repeat(257) }).success,
    ).toBe(false);
    expect(
      DevToolsNodeSchema.safeParse({ backendNodeId: 1, shadowRootType: 'sealed' }).success,
    ).toBe(false);
    // Deep in the tree too.
    const deep = JSON.parse(JSON.stringify(DOCUMENT)) as { root: DevToolsNode };
    const span = deep.root.children?.[1]?.children?.[0]?.shadowRoots?.[0]?.children?.[0];
    if (span !== undefined) span.attributes = ['data-role'];
    expect(DevToolsDocumentSchema.safeParse(deep).success).toBe(false);
    const quad = (content: unknown[]): boolean =>
      DevToolsBoxModelSchema.safeParse({ model: { content } }).success;
    expect(quad([1, 2, 3, 4, 5, 6, 7])).toBe(false);
    expect(quad([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(false);
    expect(quad([1, 2, 3, 4, 5, 6, 7, Number.POSITIVE_INFINITY])).toBe(false);
    expect(quad([1, 2, 3, 4, 5, 6, 7, Number.NaN])).toBe(false);
    expect(quad([1, 2, 3, 4, 5, 6, 7, '8'])).toBe(false);
    expect(DevToolsNodeAtSchema.safeParse({}).success).toBe(false);
    expect(
      DevToolsRemoteObjectSchema.safeParse({ object: { objectId: 'x'.repeat(257) } }).success,
    ).toBe(false);
    expect(DevToolsCallResultSchema.safeParse({ exceptionDetails: { text: 'x' } }).success).toBe(
      false,
    );
    expect(DevToolsCallResultSchema.safeParse({ result: {}, exceptionDetails: {} }).success).toBe(
      false,
    );
  });
});

describe('the devtools subpath', () => {
  it('is exported in the workspace and once packed, and never from the index', () => {
    expect(manifest.exports['./devtools']).toBe('./src/devtools.ts');
    expect(manifest.publishConfig.exports['./devtools']).toEqual({
      types: './dist/devtools.d.ts',
      default: './dist/devtools.js',
    });
    expect(Object.keys(exported).filter((name) => name.startsWith('DevTools'))).toEqual([]);
  });

  it('resolves by its package name', async () => {
    const byName = await import('@tabdock/protocol/devtools');
    expect(byName.DevToolsNodeSchema).toBe(DevToolsNodeSchema);
  });
});
