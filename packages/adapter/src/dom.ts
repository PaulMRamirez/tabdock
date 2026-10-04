// The DOM calls the widget makes on its own nodes, taken from the page's
// prototypes once, when the widget mounts inside attach(), and made through
// the Reflect.apply taken in taken.ts. A page script that runs after attach()
// and patched a DOM member the widget then called would be handed one of the
// widget's nodes, and getRootNode() on any of them returns the closed shadow
// root: the pairing code, a shown invite link and every button, to read and
// rewrite. The A4.3 review found getBoundingClientRect doing that every
// second; textContent's setter and the dataset getter did the same. Each
// reflecting property the widget sets (class, hidden, disabled, title, type
// and data-*) goes through its attribute, so a handful of taken functions
// cover them all; an input's value and checked state are properties of their
// own and are taken too. What this leaves open is in widget.ts's header.

import { apply, taken } from './taken.ts';

export interface Dom {
  create<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  text(node: Node): string;
  setText(node: Node, text: string): void;
  attr(node: Element, name: string, value: string): void;
  /** Sets or removes a boolean attribute such as hidden or disabled. */
  flag(node: Element, name: string, on: boolean): void;
  has(node: Element, name: string): boolean;
  append(parent: Element, ...children: (Node | string)[]): void;
  prepend(parent: Element, child: Node): void;
  replaceChildren(parent: Element, children: readonly Node[]): void;
  remove(node: Element): void;
  rect(node: Element): DOMRectReadOnly;
  listen(target: EventTarget, type: string, listener: (event: Event) => void): void;
  value(input: HTMLInputElement): string;
  setValue(input: HTMLInputElement, value: string): void;
  checked(input: HTMLInputElement): boolean;
  setChecked(input: HTMLInputElement, checked: boolean): void;
}

/** Takes the DOM members the widget uses from `doc` and its prototypes, as they are now. */
export function takeDom(doc: Document): Dom {
  const createElement = taken(doc, 'createElement', 'value');
  // An input's chain holds every Node, Element and HTMLElement member as well as its own.
  const probe = apply(createElement, doc, ['input']) as HTMLInputElement;
  const getText = taken(probe, 'textContent', 'get');
  const setText = taken(probe, 'textContent', 'set');
  const setAttribute = taken(probe, 'setAttribute', 'value');
  const toggleAttribute = taken(probe, 'toggleAttribute', 'value');
  const hasAttribute = taken(probe, 'hasAttribute', 'value');
  const append = taken(probe, 'append', 'value');
  const prepend = taken(probe, 'prepend', 'value');
  const replaceChildren = taken(probe, 'replaceChildren', 'value');
  const remove = taken(probe, 'remove', 'value');
  const getBoundingClientRect = taken(probe, 'getBoundingClientRect', 'value');
  const addEventListener = taken(probe, 'addEventListener', 'value');
  const getValue = taken(probe, 'value', 'get');
  const setValue = taken(probe, 'value', 'set');
  const getChecked = taken(probe, 'checked', 'get');
  const setChecked = taken(probe, 'checked', 'set');
  return Object.freeze({
    create: <K extends keyof HTMLElementTagNameMap>(tag: K) =>
      apply(createElement, doc, [tag]) as HTMLElementTagNameMap[K],
    text: (node: Node) => (apply(getText, node, []) as string | null) ?? '',
    setText: (node: Node, text: string) => {
      apply(setText, node, [text]);
    },
    attr: (node: Element, name: string, value: string) => {
      apply(setAttribute, node, [name, value]);
    },
    flag: (node: Element, name: string, on: boolean) => {
      apply(toggleAttribute, node, [name, on]);
    },
    has: (node: Element, name: string) => apply(hasAttribute, node, [name]) as boolean,
    append: (parent: Element, ...children: (Node | string)[]) => {
      apply(append, parent, children);
    },
    prepend: (parent: Element, child: Node) => {
      apply(prepend, parent, [child]);
    },
    replaceChildren: (parent: Element, children: readonly Node[]) => {
      apply(replaceChildren, parent, children);
    },
    remove: (node: Element) => {
      apply(remove, node, []);
    },
    rect: (node: Element) => apply(getBoundingClientRect, node, []) as DOMRectReadOnly,
    listen: (target: EventTarget, type: string, listener: (event: Event) => void) => {
      apply(addEventListener, target, [type, listener]);
    },
    value: (input: HTMLInputElement) => apply(getValue, input, []) as string,
    setValue: (input: HTMLInputElement, value: string) => {
      apply(setValue, input, [value]);
    },
    checked: (input: HTMLInputElement) => apply(getChecked, input, []) as boolean,
    setChecked: (input: HTMLInputElement, checked: boolean) => {
      apply(setChecked, input, [checked]);
    },
  });
}
