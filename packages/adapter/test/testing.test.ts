// ADR 0041's testing helper against a scripted DevTools session: it reads the
// pairing code and the waiting prompts only from the closed shadow root of
// the one tabdock-dock host, presses only a button that is armed and that a
// hit test confirms, both checked again just before the press, approves an
// attach request only when exactly one matches, stops on a reply in the wrong
// shape, and quotes nothing it read in what it throws.

import { describe, expect, it } from 'vitest';
import {
  allowAttach,
  clickInWidget,
  type DevToolsSession,
  maskCode,
  readPairingCode,
  waitingPrompts,
  widgetButton,
  widgetText,
  WidgetTestError,
} from '../src/testing.ts';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FakeNode {
  backendNodeId: number;
  nodeType: number;
  localName: string;
  nodeValue?: string;
  attributes: string[];
  children: FakeNode[];
  shadowRoots?: FakeNode[];
  shadowRootType?: 'user-agent' | 'open' | 'closed';
  contentDocument?: FakeNode;
  box?: Box;
}

let nextId = 1;

function el(
  localName: string,
  attrs: Record<string, string> = {},
  children: FakeNode[] = [],
  box?: Box,
): FakeNode {
  return {
    backendNodeId: nextId++,
    nodeType: 1,
    localName,
    attributes: Object.entries(attrs).flat(),
    children,
    ...(box ? { box } : {}),
  };
}

function text(value: string): FakeNode {
  return {
    backendNodeId: nextId++,
    nodeType: 3,
    localName: '',
    nodeValue: value,
    attributes: [],
    children: [],
  };
}

function shadow(type: 'open' | 'closed', children: FakeNode[]): FakeNode {
  return {
    backendNodeId: nextId++,
    nodeType: 11,
    localName: '',
    attributes: [],
    children,
    shadowRootType: type,
  };
}

/** The widget's host with its closed shadow root. */
function dock(children: FakeNode[], type: 'open' | 'closed' = 'closed'): FakeNode {
  return { ...el('tabdock-dock'), shadowRoots: [shadow(type, children)] };
}

function documentOf(...body: FakeNode[]): FakeNode {
  return {
    backendNodeId: nextId++,
    nodeType: 9,
    localName: '',
    attributes: [],
    children: [el('html', { lang: 'en' }, [el('body', {}, body)])],
  };
}

function code(value: string): FakeNode {
  return el('div', { 'data-role': 'pairing-code' }, value === '' ? [] : [text(value)]);
}

function button(action: string, box: Box, armed?: boolean): FakeNode {
  const attrs: Record<string, string> = { type: 'button', 'data-action': action };
  if (armed !== undefined) attrs['data-armed'] = String(armed);
  // A label inside the button, which a hit test may name instead of the button.
  const label = el('span', {}, [text(action)], {
    x: box.x + 2,
    y: box.y + 2,
    width: box.width - 4,
    height: box.height - 4,
  });
  return el('button', attrs, [label], box);
}

/** An attach prompt as the widget draws it, with its two Allow buttons and Deny, armed or not. */
function prompt(requestId: string, client: string | null, top: number, armed = true): FakeNode {
  const attrs: Record<string, string> = { 'data-request-id': requestId };
  if (client !== null) attrs['data-client-name'] = client;
  return el(
    'div',
    attrs,
    [
      el('p', {}, [text(`You want to attach via code`)]),
      el('div', { class: 'buttons' }, [
        button('approve-driver', { x: 10, y: top + 40, width: 100, height: 20 }, armed),
        button('approve-observer', { x: 120, y: top + 40, width: 100, height: 20 }, armed),
        button('deny', { x: 230, y: top + 40, width: 60, height: 20 }, armed),
      ]),
    ],
    { x: 0, y: top, width: 300, height: 80 },
  );
}

function attr(node: FakeNode, name: string): string | undefined {
  for (let i = 0; i + 1 < node.attributes.length; i += 2) {
    if (node.attributes[i] === name) return node.attributes[i + 1];
  }
  return undefined;
}

function setAttr(node: FakeNode, name: string, value: string): void {
  for (let i = 0; i + 1 < node.attributes.length; i += 2) {
    if (node.attributes[i] === name) {
      node.attributes[i + 1] = value;
      return;
    }
  }
  node.attributes.push(name, value);
}

function* everyNode(node: FakeNode): Generator<FakeNode> {
  yield node;
  for (const next of [...node.children, ...(node.shadowRoots ?? [])]) yield* everyNode(next);
  if (node.contentDocument) yield* everyNode(node.contentDocument);
}

function inside(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A DevTools session over a scripted document. Every command is recorded; a
 * test may answer one itself through `answer`, and `onSend` runs before each
 * command is answered, so a test can change the page between two commands.
 * Boxes are in document coordinates. As Chromium does, it answers a box and
 * takes a press in the viewport's coordinates, and hit-tests a point in the
 * document's, so a test that scrolls the page tells the two apart.
 */
class FakeSession implements DevToolsSession {
  readonly sent: Sent[] = [];
  root: FakeNode;
  /** Where the viewport's corner sits in the document. */
  scroll = { x: 0, y: 0 };
  viewport = { width: 1280, height: 800 };
  answer: (method: string, params: Record<string, unknown>) => unknown = () => undefined;
  onSend: (method: string, params: Record<string, unknown>) => void = () => undefined;
  /** What a hit test at a point names; by default the innermost node whose box holds it. */
  hit: (x: number, y: number) => number | null = (x, y) => {
    let found: number | null = null;
    for (const node of everyNode(this.root)) {
      if (node.box && inside(node.box, x, y)) found = node.backendNodeId;
    }
    return found;
  };

  constructor(root: FakeNode) {
    this.root = root;
  }

  node(backendNodeId: number): FakeNode | undefined {
    for (const node of everyNode(this.root)) if (node.backendNodeId === backendNodeId) return node;
    return undefined;
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const p = params as Record<string, unknown>;
    this.sent.push({ method, params: p });
    this.onSend(method, p);
    const scripted = this.answer(method, p);
    if (scripted !== undefined) return Promise.resolve(scripted);
    switch (method) {
      case 'DOM.getDocument':
        return Promise.resolve({ root: structuredClone(this.root) });
      case 'DOM.scrollIntoViewIfNeeded':
      case 'Input.dispatchMouseEvent':
        return Promise.resolve({});
      case 'DOM.getBoxModel': {
        const box = this.node(Number(p.backendNodeId))?.box;
        if (!box) return Promise.reject(new Error('Could not compute box model.'));
        const { width, height } = box;
        const x = box.x - this.scroll.x;
        const y = box.y - this.scroll.y;
        const quad = [x, y, x + width, y, x + width, y + height, x, y + height];
        return Promise.resolve({ model: { content: quad, width, height } });
      }
      case 'Page.getLayoutMetrics': {
        const view = {
          offsetX: 0,
          offsetY: 0,
          pageX: this.scroll.x,
          pageY: this.scroll.y,
          clientWidth: this.viewport.width,
          clientHeight: this.viewport.height,
          scale: 1,
          zoom: 1,
        };
        return Promise.resolve({ cssVisualViewport: view, cssLayoutViewport: view });
      }
      case 'DOM.getNodeForLocation': {
        const id = this.hit(Number(p.x), Number(p.y));
        if (id === null) return Promise.reject(new Error('No node found at given location'));
        return Promise.resolve({ backendNodeId: id, frameId: 'main' });
      }
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  }

  /** What a press at a viewport point would hit. */
  pressed(x: number, y: number): number | null {
    return this.hit(x + this.scroll.x, y + this.scroll.y);
  }

  /** The document points the helper hit-tested. */
  hitTests(): { x: unknown; y: unknown }[] {
    return this.sent
      .filter((sent) => sent.method === 'DOM.getNodeForLocation')
      .map(({ params }) => ({ x: params.x, y: params.y }));
  }

  mouse(): { type: unknown; x: unknown; y: unknown }[] {
    return this.sent
      .filter((sent) => sent.method === 'Input.dispatchMouseEvent')
      .map(({ params }) => ({ type: params.type, x: params.x, y: params.y }));
  }

  presses(): number {
    return this.mouse().filter((event) => event.type === 'mousePressed').length;
  }
}

/** Removes the prompt for `requestId` when a press is released, as the widget does on an approval. */
function approvesOnRelease(cdp: FakeSession): void {
  cdp.onSend = (method, params) => {
    if (method !== 'Input.dispatchMouseEvent' || params.type !== 'mouseReleased') return;
    const at = cdp.pressed(Number(params.x), Number(params.y));
    for (const node of everyNode(cdp.root)) {
      const gone = node.children.find(
        (child) =>
          attr(child, 'data-request-id') !== undefined &&
          [...everyNode(child)].some((inner) => inner.backendNodeId === at),
      );
      if (gone) node.children.splice(node.children.indexOf(gone), 1);
    }
  };
}

const CI = 'tabdock-ci-check';

describe('maskCode', () => {
  it('hides the second half of a code, and the whole of one with no dash', () => {
    expect(maskCode('ABCDE-FGHJK')).toBe('ABCDE-*****');
    expect(maskCode('ABCDEFGHJK')).toBe('**********');
  });
});

describe('readPairingCode', () => {
  it('waits through an empty code and returns the one the widget then shows', async () => {
    const shown = code('');
    const cdp = new FakeSession(documentOf(dock([shown])));
    let reads = 0;
    cdp.onSend = (method) => {
      if (method === 'DOM.getDocument' && ++reads === 3) shown.children.push(text('ABCDE-FGHJK'));
    };
    await expect(readPairingCode(cdp, { timeoutMs: 2000 })).resolves.toBe('ABCDE-FGHJK');
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('times out on text the protocol refuses as a code, and its error never quotes it', async () => {
    const read = 'Q7'.repeat(20);
    const cdp = new FakeSession(documentOf(dock([code(read)])));
    const error = await readPairingCode(cdp, { timeoutMs: 250 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WidgetTestError);
    expect((error as Error).message).not.toContain(read);
    expect((error as Error).message).not.toContain('Q7Q7');
  });

  it('never reads a pairing-code role outside the widget, in light DOM or in a frame', async () => {
    const framed = documentOf(dock([code('FRAME-CODE1')]));
    const cdp = new FakeSession(
      documentOf(code('LIGHT-CODE1'), { ...el('iframe'), contentDocument: framed }),
    );
    await expect(readPairingCode(cdp, { timeoutMs: 250 })).rejects.toThrow(WidgetTestError);
    expect(await widgetText(cdp, 'pairing-code')).toBeNull();

    // With the widget beside them, only the widget's own code is read.
    const both = new FakeSession(
      documentOf(code('LIGHT-CODE1'), dock([code('ABCDE-FGHJK')]), {
        ...el('iframe'),
        contentDocument: framed,
      }),
    );
    await expect(readPairingCode(both, { timeoutMs: 250 })).resolves.toBe('ABCDE-FGHJK');
  });

  it('refuses two widget hosts, even one inside a shadow tree of the page', async () => {
    const two = new FakeSession(
      documentOf(dock([code('ABCDE-FGHJK')]), dock([code('XXXXX-YYYYY')])),
    );
    await expect(readPairingCode(two)).rejects.toThrow('more than one Tabdock widget on the page');
    const hidden = {
      ...el('my-card'),
      shadowRoots: [shadow('open', [dock([code('XXXXX-YYYYY')])])],
    };
    const nested = new FakeSession(documentOf(dock([code('ABCDE-FGHJK')]), hidden));
    await expect(readPairingCode(nested)).rejects.toThrow(
      'more than one Tabdock widget on the page',
    );
  });

  it('refuses a host whose shadow root is not closed, which the adapter never makes', async () => {
    const cdp = new FakeSession(documentOf(dock([code('ABCDE-FGHJK')], 'open')));
    await expect(readPairingCode(cdp)).rejects.toThrow('has no closed shadow root');
  });
});

describe('replies in the wrong shape', () => {
  const cases: [string, (cdp: FakeSession) => void][] = [
    [
      'a string backendNodeId',
      (cdp) => {
        cdp.answer = (method) =>
          method === 'DOM.getDocument' ? { root: { backendNodeId: 'three' } } : undefined;
      },
    ],
    [
      'an odd attribute list',
      (cdp) => {
        cdp.answer = (method) =>
          method === 'DOM.getDocument'
            ? { root: { backendNodeId: 1, attributes: ['data-role'] } }
            : undefined;
      },
    ],
    [
      'a box of seven numbers',
      (cdp) => {
        cdp.answer = (method) =>
          method === 'DOM.getBoxModel' ? { model: { content: [0, 0, 1, 0, 1, 1, 0] } } : undefined;
      },
    ],
    [
      'layout metrics with no visual viewport',
      (cdp) => {
        cdp.answer = (method) =>
          method === 'Page.getLayoutMetrics' ? { cssLayoutViewport: {} } : undefined;
      },
    ],
    [
      'a hit test with no node',
      (cdp) => {
        cdp.answer = (method) =>
          method === 'DOM.getNodeForLocation' ? { frameId: 'main' } : undefined;
      },
    ],
  ];
  for (const [name, spoil] of cases) {
    it(`stop the helper with WidgetTestError rather than steer a click: ${name}`, async () => {
      const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
      spoil(cdp);
      const error = await allowAttach(cdp, { as: 'driver', client: CI, timeoutMs: 500 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(WidgetTestError);
      expect((error as Error).message).toMatch(
        /^the DevTools protocol answered \S+ in an unexpected shape$/,
      );
      expect(cdp.mouse()).toEqual([]);
    });
  }

  it('stops a text read whose text value is malformed', async () => {
    const shown = code('');
    shown.children.push({ ...text(''), nodeValue: 42 as unknown as string });
    const cdp = new FakeSession(documentOf(dock([shown])));
    await expect(widgetText(cdp, 'pairing-code')).rejects.toThrow(
      'the DevTools protocol answered DOM.getDocument in an unexpected shape',
    );
  });
});

describe('allowAttach', () => {
  it('moves to, presses and releases on the one matching prompt’s Allow as driver, and returns its id', async () => {
    const cdp = new FakeSession(
      documentOf(dock([prompt('req-other', 'someone-else', 0), prompt('req-ci', CI, 100)])),
    );
    approvesOnRelease(cdp);
    await expect(allowAttach(cdp, { as: 'driver', client: CI })).resolves.toBe('req-ci');
    // The centre of req-ci's approve-driver button: x 10 to 110, y 140 to 160.
    expect(cdp.mouse()).toEqual([
      { type: 'mouseMoved', x: 60, y: 150 },
      { type: 'mousePressed', x: 60, y: 150 },
      { type: 'mouseReleased', x: 60, y: 150 },
    ]);
    const pressed = cdp.sent.find(
      (s) => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mousePressed',
    );
    expect(pressed?.params).toMatchObject({ button: 'left', clickCount: 1, buttons: 1 });
  });

  it('presses Allow as observer when asked to', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-ci', CI, 0)])));
    approvesOnRelease(cdp);
    await expect(allowAttach(cdp, { as: 'observer', requestId: 'req-ci' })).resolves.toBe('req-ci');
    expect(cdp.mouse().map((event) => [event.x, event.y])).toEqual([
      [170, 50],
      [170, 50],
      [170, 50],
    ]);
  });

  it('throws, pressing nothing, when two waiting prompts carry the client name, and never quotes it', async () => {
    const cdp = new FakeSession(
      documentOf(dock([prompt('req-1', CI, 0), prompt('req-2', CI, 100)])),
    );
    const error = await allowAttach(cdp, { as: 'driver', client: CI }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WidgetTestError);
    expect((error as Error).message).toBe('2 waiting attach requests match, so none is approved');
    expect(cdp.mouse()).toEqual([]);
  });

  it('throws, pressing nothing, when a second matching prompt arrives between the aim and the press', async () => {
    const box = dock([prompt('req-1', CI, 0)]);
    const cdp = new FakeSession(documentOf(box));
    cdp.onSend = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        box.shadowRoots?.[0]?.children.unshift(prompt('req-2', CI, 200));
      }
    };
    await expect(allowAttach(cdp, { as: 'driver', client: CI })).rejects.toThrow(
      '2 waiting attach requests match, so none is approved',
    );
    expect(cdp.presses()).toBe(0);
  });

  it('matches the client name exactly, never a name that merely starts with it', async () => {
    const lookalike = new FakeSession(documentOf(dock([prompt('req-x', `${CI}-other`, 0)])));
    await expect(
      allowAttach(lookalike, { as: 'driver', client: CI, timeoutMs: 300 }),
    ).rejects.toThrow('no waiting attach request matched within 300 ms');
    expect(lookalike.mouse()).toEqual([]);

    const both = new FakeSession(
      documentOf(dock([prompt('req-x', `${CI}-other`, 0), prompt('req-ci', CI, 100)])),
    );
    approvesOnRelease(both);
    await expect(allowAttach(both, { as: 'driver', client: CI })).resolves.toBe('req-ci');
    // A prompt with no client name never matches one.
    const nameless = new FakeSession(documentOf(dock([prompt('req-n', null, 0)])));
    await expect(
      allowAttach(nameless, { as: 'driver', client: CI, timeoutMs: 200 }),
    ).rejects.toThrow(WidgetTestError);
  });

  it('takes a request id, so two prompts from one client can be told apart', async () => {
    const cdp = new FakeSession(
      documentOf(dock([prompt('req-1', CI, 0), prompt('req-2', CI, 100)])),
    );
    approvesOnRelease(cdp);
    await expect(allowAttach(cdp, { as: 'driver', requestId: 'req-2' })).resolves.toBe('req-2');
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 60, y: 150 });
  });

  it('refuses options naming both a client and a request id, or neither', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
    const both = { as: 'driver', client: CI, requestId: 'req-1' } as unknown as Parameters<
      typeof allowAttach
    >[1];
    await expect(allowAttach(cdp, both)).rejects.toThrow(TypeError);
    const neither = { as: 'driver' } as unknown as Parameters<typeof allowAttach>[1];
    await expect(allowAttach(cdp, neither)).rejects.toThrow(TypeError);
    expect(cdp.sent).toEqual([]);
  });
});

describe('arming and the hit test', () => {
  it('presses no button while its box is not armed, and presses once it is', async () => {
    const waiting = prompt('req-1', CI, 0, false);
    const cdp = new FakeSession(documentOf(dock([waiting])));
    let reads = 0;
    const armedAtPress: (string | undefined)[] = [];
    cdp.onSend = (method) => {
      if (method === 'DOM.getDocument' && ++reads === 4) {
        for (const node of everyNode(waiting)) {
          if (attr(node, 'data-armed') !== undefined) setAttr(node, 'data-armed', 'true');
        }
      }
      if (method === 'Input.dispatchMouseEvent') {
        const allow = [...everyNode(waiting)].find(
          (n) => attr(n, 'data-action') === 'approve-driver',
        );
        armedAtPress.push(allow && attr(allow, 'data-armed'));
      }
    };
    await clickInWidget(cdp, { action: 'approve-driver', requestId: 'req-1' });
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(armedAtPress).toEqual(['true', 'true', 'true']);
  });

  it('never presses a button that stays unarmed', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0, false)])));
    await expect(
      clickInWidget(cdp, { action: 'approve-driver', requestId: 'req-1' }, { timeoutMs: 300 }),
    ).rejects.toThrow('no armed approve-driver button a click would reach within 300 ms');
    expect(cdp.mouse()).toEqual([]);
  });

  it('presses no button a hit test says something else covers', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
    const cover = el('div', { id: 'cover' });
    cdp.root.children.push(cover);
    cdp.hit = () => cover.backendNodeId;
    await expect(
      clickInWidget(cdp, { action: 'approve-driver', requestId: 'req-1' }, { timeoutMs: 300 }),
    ).rejects.toThrow(WidgetTestError);
    expect(cdp.mouse()).toEqual([]);
    await expect(
      widgetButton(cdp, { action: 'approve-driver', requestId: 'req-1' }, { timeoutMs: 200 }),
    ).rejects.toThrow(WidgetTestError);
  });

  it('presses when the hit test names a label inside the button', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
    await clickInWidget(cdp, { action: 'deny', requestId: 'req-1' });
    // The default hit test names the innermost box, the button's label.
    expect(cdp.presses()).toBe(1);
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 260, y: 50 });
  });

  it('checks again after moving, and does not press a button that lost its arming meanwhile', async () => {
    const waiting = prompt('req-1', CI, 0);
    const cdp = new FakeSession(documentOf(dock([waiting])));
    let moves = 0;
    const armedAtPress: (string | undefined)[] = [];
    const allow = [...everyNode(waiting)].find((n) => attr(n, 'data-action') === 'approve-driver');
    if (!allow) throw new Error('no allow button');
    let readsSinceShift = 0;
    cdp.onSend = (method, params) => {
      // The first move lands as the box shifts: the widget disarms it until it holds still again.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && ++moves === 1) {
        setAttr(allow, 'data-armed', 'false');
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        armedAtPress.push(attr(allow, 'data-armed'));
      }
      if (method === 'DOM.getDocument' && moves === 1 && ++readsSinceShift === 3) {
        setAttr(allow, 'data-armed', 'true');
      }
    };
    await clickInWidget(cdp, { action: 'approve-driver', requestId: 'req-1' });
    expect(moves).toBe(2);
    expect(armedAtPress).toEqual(['true']);
    expect(cdp.presses()).toBe(1);
  });

  it('refuses to choose when a target naming no box matches more than one button, pressing nothing', async () => {
    const cdp = new FakeSession(
      documentOf(dock([prompt('req-1', CI, 0), prompt('req-2', 'someone-else', 100)])),
    );
    for (const action of ['approve-driver', 'approve-observer', 'deny'] as const) {
      await expect(clickInWidget(cdp, { action })).rejects.toThrow(
        new WidgetTestError(`2 ${action} buttons match, so none is pressed`),
      );
      await expect(widgetButton(cdp, { action })).rejects.toThrow(WidgetTestError);
    }
    expect(cdp.mouse()).toEqual([]);

    // One prompt, or a box named: the one button is pressed.
    const one = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
    await clickInWidget(one, { action: 'approve-driver' });
    expect(one.presses()).toBe(1);
    await clickInWidget(cdp, { action: 'deny', requestId: 'req-2' });
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 260, y: 150 });
  });

  it('presses one proposal’s Accept by its id, where every row repeats the button (ADR 0042)', async () => {
    const row = (proposalId: string, top: number): FakeNode =>
      el(
        'li',
        { 'data-proposal-id': proposalId },
        [
          button('proposal-accept', { x: 10, y: top + 40, width: 80, height: 20 }, true),
          button('proposal-dismiss', { x: 100, y: top + 40, width: 80, height: 20 }, true),
        ],
        { x: 0, y: top, width: 300, height: 80 },
      );
    const cdp = new FakeSession(documentOf(dock([row('pr_1', 0), row('pr_2', 100)])));
    await expect(clickInWidget(cdp, { action: 'proposal-accept' })).rejects.toThrow(
      new WidgetTestError('2 proposal-accept buttons match, so none is pressed'),
    );
    expect(cdp.mouse()).toEqual([]);
    await clickInWidget(cdp, { action: 'proposal-accept', proposalId: 'pr_2' });
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 50, y: 150 });
  });

  it('on a scrolled page, hit-tests the document point under the button and presses its viewport point', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 400)])));
    cdp.scroll = { x: 0, y: 135 };
    await clickInWidget(cdp, { action: 'deny', requestId: 'req-1' });
    // Deny's centre is (260, 450) in the document, 135 px higher in the viewport.
    expect(cdp.presses()).toBe(1);
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 260, y: 315 });
    expect(new Set(cdp.hitTests().map((at) => JSON.stringify(at)))).toEqual(
      new Set([JSON.stringify({ x: 260, y: 450 })]),
    );
  });

  it('on a scrolled page, presses no button whose centre is covered, though the spot it scrolled from is clear', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 0)])));
    cdp.scroll = { x: 0, y: 8 };
    // Over Deny's centre, (260, 50) in the document, and not over (260, 42),
    // the point a hit test made in viewport coordinates would check.
    const cover = el('div', { id: 'cover' }, [], { x: 255, y: 46, width: 10, height: 8 });
    cdp.root.children.push(cover);
    await expect(
      clickInWidget(cdp, { action: 'deny', requestId: 'req-1' }, { timeoutMs: 300 }),
    ).rejects.toThrow(WidgetTestError);
    expect(cdp.mouse()).toEqual([]);

    cdp.root.children.pop();
    await clickInWidget(cdp, { action: 'deny', requestId: 'req-1' });
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 260, y: 42 });
  });

  it('presses no button whose centre is outside the viewport, until the page scrolls it in', async () => {
    const cdp = new FakeSession(documentOf(dock([prompt('req-1', CI, 400)])));
    cdp.viewport = { width: 1280, height: 300 };
    await expect(
      clickInWidget(cdp, { action: 'deny', requestId: 'req-1' }, { timeoutMs: 300 }),
    ).rejects.toThrow(WidgetTestError);
    expect(cdp.mouse()).toEqual([]);
    expect(cdp.hitTests()).toEqual([]);

    cdp.scroll = { x: 0, y: 200 };
    await clickInWidget(cdp, { action: 'deny', requestId: 'req-1' });
    expect(cdp.mouse()[1]).toEqual({ type: 'mousePressed', x: 260, y: 250 });
  });

  it('refuses an action the widget does not have', async () => {
    const cdp = new FakeSession(documentOf(dock([])));
    const target = { action: 'approve-everyone' } as unknown as Parameters<typeof clickInWidget>[1];
    await expect(clickInWidget(cdp, target)).rejects.toThrow(TypeError);
    expect(cdp.sent).toEqual([]);
  });
});

describe('timeoutMs', () => {
  // A wait of NaN never ends: Date.now() >= NaN is false for ever, so a CI
  // script passing Number() of an unset variable would hang to the job's end.
  const entries: [string, (cdp: FakeSession, timeoutMs: number) => Promise<unknown>][] = [
    ['readPairingCode', (cdp, timeoutMs) => readPairingCode(cdp, { timeoutMs })],
    [
      'widgetButton',
      (cdp, timeoutMs) => widgetButton(cdp, { action: 'deny', requestId: 'req-1' }, { timeoutMs }),
    ],
    [
      'clickInWidget',
      (cdp, timeoutMs) => clickInWidget(cdp, { action: 'deny', requestId: 'req-1' }, { timeoutMs }),
    ],
    ['allowAttach', (cdp, timeoutMs) => allowAttach(cdp, { as: 'driver', client: CI, timeoutMs })],
  ];
  for (const [name, call] of entries) {
    it(`${name} refuses a wait that is not a finite count of milliseconds, sending nothing`, async () => {
      for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        // Nothing here ever resolves: no code, and an unarmed prompt from another client.
        const cdp = new FakeSession(
          documentOf(dock([code(''), prompt('req-1', 'other', 100, false)])),
        );
        await expect(call(cdp, timeoutMs)).rejects.toThrow(
          new TypeError('timeoutMs must be a finite number of milliseconds, 0 or more'),
        );
        expect(cdp.sent).toEqual([]);
      }
      // 0 looks once, then gives up.
      const once = new FakeSession(
        documentOf(dock([code(''), prompt('req-1', 'other', 100, false)])),
      );
      await expect(call(once, 0)).rejects.toThrow(WidgetTestError);
    });
  }
});

describe('what it sends', () => {
  // Only DevTools' own view of the DOM and trusted input: no function runs in
  // the page, whose own world a script loaded after attach() may have patched,
  // so such a script is handed none of the widget's nodes.
  const PAGE_FREE = new Set([
    'DOM.getDocument',
    'DOM.scrollIntoViewIfNeeded',
    'DOM.getBoxModel',
    'DOM.getNodeForLocation',
    'Page.getLayoutMetrics',
    'Input.dispatchMouseEvent',
  ]);

  it('is DOM reads and trusted input alone, from every export', async () => {
    const shown = code('ABCDE-FGHJK');
    const cdp = new FakeSession(documentOf(dock([shown, prompt('req-1', CI, 100)])));
    approvesOnRelease(cdp);
    await readPairingCode(cdp);
    await widgetText(cdp, 'pairing-code');
    await waitingPrompts(cdp);
    await widgetButton(cdp, { action: 'deny', requestId: 'req-1' });
    await allowAttach(cdp, { as: 'driver', client: CI });
    const second = new FakeSession(documentOf(dock([prompt('req-2', CI, 0)])));
    await clickInWidget(second, { action: 'deny', requestId: 'req-2' });
    const sent = [...cdp.sent, ...second.sent].map((s) => s.method);
    expect(sent).toContain('Input.dispatchMouseEvent');
    expect(sent.filter((method) => !PAGE_FREE.has(method))).toEqual([]);
  });

  it('reads text from the tree DevTools sends, in document order, leaving out comments', async () => {
    const line = el('div', { 'data-role': 'activity' }, [
      el('span', { class: 'time' }, [text('12:00:01')]),
      text(' '),
      el('span', {}, [text('Alice'), { ...text('a note'), nodeType: 8 }, text(': get_view')]),
    ]);
    const cdp = new FakeSession(documentOf(dock([line])));
    expect(await widgetText(cdp, 'activity')).toBe('12:00:01 Alice: get_view');
    expect(await widgetText(cdp, 'roster')).toBeNull();
  });
});

describe('waitingPrompts', () => {
  it('lists the attach prompts with their client names, and the confirm prompts', async () => {
    const confirm = el('div', { 'data-call-id': 'call-1' }, [
      button('confirm-allow', { x: 0, y: 300, width: 50, height: 20 }, true),
    ]);
    const cdp = new FakeSession(
      documentOf(
        code('LIGHT-CODE1'),
        el('div', { 'data-request-id': 'light' }),
        dock([prompt('req-1', CI, 0), prompt('req-2', null, 100), confirm]),
      ),
    );
    expect(await waitingPrompts(cdp)).toEqual({
      attach: [
        { requestId: 'req-1', client: CI },
        { requestId: 'req-2', client: null },
      ],
      confirm: [{ callId: 'call-1' }],
    });
    expect(await waitingPrompts(new FakeSession(documentOf()))).toEqual({
      attach: [],
      confirm: [],
    });
  });
});
