// How the relay's commands name an argument they refuse (ADR 0028): a flag
// by its name, anything else only by its place. A token pasted in the wrong
// place is still a token, so `tabdock-relay`, `pnpm relay`, `tabdock-relay
// audit` and `pnpm audit:log` never repeat one, whatever node's own parser
// would have said.

/** Only what looks like a flag name the commands could take is ever repeated. */
const FLAG_NAME = /^--?[a-z][a-z-]{0,31}$/;

/** An argument as a refusal names it; `position` counts from 1. */
export function namedArgument(arg: string, position: number): string {
  return FLAG_NAME.test(arg) ? `the option ${arg}` : `argument ${String(position)}`;
}
