// Built-ins the adapter takes once, by the time attach() returns, so that a
// page script that runs later and replaces one on its prototype is never
// called with what the adapter hands it (docs/threat-model.md, B5). Which
// built-ins are taken, and what stays open, is written where each is used:
// index.ts for the page link's socket, dom.ts and qr.ts for the widget.

/** Reflect.apply as it was when this module loaded, before attach() ran. */
export const apply = Reflect.apply;

/** A function a prototype chain held when it was taken. */
export type Taken = (...args: never[]) => unknown;

/**
 * A method, or one half of an accessor, as the prototype chain from `start`
 * holds it now: the nearest own property of that name, which must be a
 * function in the part asked for. Throws where there is none, since calling
 * through whatever a later script put there instead is what this prevents.
 */
export function taken(start: object, name: string, part: 'value' | 'get' | 'set'): Taken {
  for (let proto: object | null = start; proto !== null; proto = Reflect.getPrototypeOf(proto)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined) continue;
    const found: unknown = descriptor[part];
    if (typeof found !== 'function') break;
    return found as Taken;
  }
  throw new TypeError(`no ${name} ${part === 'value' ? 'method' : part} to take`);
}
