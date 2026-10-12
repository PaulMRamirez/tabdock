// The widget's names (packages/adapter/src/widget-names.ts, ADR 0041) are
// what browser specs and the `@tabdock/adapter/testing` helper find the
// widget's buttons and blocks by. tsc already refuses a name the widget sets
// that the lists leave out, since the widget sets each one only through its
// typed setAction and role; this holds the other half (A6.26): every name
// the lists carry is one the widget can set, so a control removed from the
// widget, or one renamed, cannot leave a stale name for a copier's CI check
// to wait on until it times out. The type checker reads each name off the
// argument the widget passes, so a name built from a template, such as
// `record-which-${view.which}`, counts once for each value its type allows.

import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { WIDGET_ACTIONS, WIDGET_ROLES } from '../../../packages/adapter/src/widget-names.ts';
import { ROOT } from '../src/doc-files.ts';

const WIDGET = join(ROOT, 'packages/adapter/src/widget.ts');
const TYPES = ['WidgetAction', 'WidgetRole'] as const;
type NameType = (typeof TYPES)[number];

interface Found {
  /** Each name the widget can pass where a WidgetAction or a WidgetRole is taken. */
  readonly names: Record<NameType, Set<string>>;
  /** Arguments whose type names no literal, so what they set cannot be read: each is a failure. */
  readonly unread: string[];
  /** How many times widget.ts's code names each attribute. */
  readonly attributes: Record<'data-action' | 'data-role', number>;
}

/** The adapter's own compiler options, so widget.ts checks here as `pnpm typecheck` checks it. */
function adapterOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, 'packages/adapter/tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (parsed === undefined) throw new Error('packages/adapter/tsconfig.json did not parse');
  return parsed.options;
}

/** Which of the two name types a parameter is declared with, if either. */
function declaredAs(parameter: ts.Symbol | undefined): NameType | null {
  const declaration = parameter?.valueDeclaration;
  if (declaration === undefined || !ts.isParameter(declaration)) return null;
  const type = declaration.type;
  if (type === undefined || !ts.isTypeReferenceNode(type)) return null;
  const name = type.typeName.getText();
  return (TYPES as readonly string[]).includes(name) ? (name as NameType) : null;
}

/** How many names each type allows: an argument allowing them all says nothing of what it sets. */
const WHOLE: Record<NameType, number> = {
  WidgetAction: WIDGET_ACTIONS.length,
  WidgetRole: WIDGET_ROLES.length,
};

/**
 * The string literals a type allows, or null when it allows any string or is
 * the whole name type, as a variable declared WidgetAction is: what such an
 * argument sets cannot be read off the source, so it must not count as
 * setting every name.
 */
function literals(type: ts.Type, takes: NameType): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  const values: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteral()) return null;
    values.push(part.value);
  }
  return values.length >= WHOLE[takes] ? null : values;
}

/** Every name the file at `path` passes to a parameter typed WidgetAction or WidgetRole. */
function collect(program: ts.Program, path: string): Found {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  if (source === undefined) throw new Error(`the program holds no ${path}`);
  const names: Found['names'] = { WidgetAction: new Set(), WidgetRole: new Set() };
  const unread: string[] = [];
  const attributes = { 'data-action': 0, 'data-role': 0 };

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) &&
      (node.text === 'data-action' || node.text === 'data-role')
    ) {
      attributes[node.text] += 1;
    }
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      node.arguments.forEach((argument, index) => {
        const takes = declaredAs(signature?.parameters[index]);
        if (takes === null) return;
        // A helper handing on a name it was given sets nothing of its own: the
        // call that gave it the name is counted where it was made.
        if (ts.isIdentifier(argument) && declaredAs(checker.getSymbolAtLocation(argument))) return;
        const values = literals(checker.getTypeAtLocation(argument), takes);
        if (values === null) {
          const { line } = source.getLineAndCharacterOfPosition(argument.getStart());
          unread.push(`line ${String(line + 1)}: ${argument.getText()}`);
          return;
        }
        for (const value of values) names[takes].add(value);
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, unread, attributes };
}

describe("the widget's names (widget-names.ts, A6.26)", () => {
  const options = adapterOptions();
  const found = collect(ts.createProgram({ rootNames: [WIDGET], options }), WIDGET);

  it('are each set somewhere in widget.ts', () => {
    const missing = [
      ...WIDGET_ACTIONS.filter((name) => !found.names.WidgetAction.has(name)),
      ...WIDGET_ROLES.filter((name) => !found.names.WidgetRole.has(name)),
    ];
    expect(missing).toEqual([]);
  });

  it('are the only names widget.ts sets, each through its one typed helper', () => {
    expect(found.unread).toEqual([]);
    const actions: readonly string[] = WIDGET_ACTIONS;
    const roles: readonly string[] = WIDGET_ROLES;
    expect([...found.names.WidgetAction].filter((name) => !actions.includes(name))).toEqual([]);
    expect([...found.names.WidgetRole].filter((name) => !roles.includes(name))).toEqual([]);
    // One place each writes the attribute, so no other path can set a name past tsc.
    expect(found.attributes).toEqual({ 'data-action': 1, 'data-role': 1 });
  });

  it('lists no name twice', () => {
    expect(new Set(WIDGET_ACTIONS).size).toBe(WIDGET_ACTIONS.length);
    expect(new Set(WIDGET_ROLES).size).toBe(WIDGET_ROLES.length);
  });

  it('reads a templated name as each value its type allows, through a helper, and a widened one as unread', () => {
    // The collector shown on a sample, so a check that found nothing could not pass.
    const sample = join(ROOT, 'packages/adapter/src/widget-names-sample.ts');
    const text = [
      "import type { WidgetAction } from './widget-names.ts';",
      'declare function setAction(action: WidgetAction): void;',
      'function choice(action: WidgetAction): void { setAction(action); }',
      "declare const which: 'current' | 'previous';",
      'declare const loose: string;',
      'choice(`record-which-${which}`);',
      "setAction(loose as 'pause');",
      'setAction(loose as WidgetAction);',
    ].join('\n');
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, onError, create) =>
      name === sample
        ? ts.createSourceFile(name, text, version, true)
        : read(name, version, onError, create);
    const seen = collect(ts.createProgram({ rootNames: [sample], options, host }), sample);
    expect([...seen.names.WidgetAction]).toEqual([
      'record-which-current',
      'record-which-previous',
      'pause',
    ]);
    expect(seen.unread).toEqual(['line 8: loose as WidgetAction']);
  });
});
