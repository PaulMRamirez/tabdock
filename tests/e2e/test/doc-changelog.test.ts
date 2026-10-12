// The CHANGELOG is where a page author or an operator learns what a release
// adds (ADR 0028), so whatever the packages' public surface gains after
// 0.1.0 is named there: each member of the control handle, each value the
// adapter exports, and each option of the audit reader. 0.1.0's surface is
// pinned here, since it shipped and cannot change; anything past it must
// appear in CHANGELOG.md by name. M6's entry once named two of its twelve
// new handle members.

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readRepo } from '../src/doc-files.ts';

/** The control handle as 0.1.0 shipped it. */
const HANDLE_0_1_0 = [
  'state',
  'on',
  'approve',
  'deny',
  'confirm',
  'rotatePairing',
  'setRole',
  'revoke',
  'cancelInvite',
  'invite',
  'pause',
  'close',
];

/** The values @tabdock/adapter exported in 0.1.0, types aside. */
const ADAPTER_VALUES_0_1_0 = ['INVITE_LIFETIMES', 'ADAPTER_VERSION', 'attach'];

/** `tabdock-relay audit`'s options in 0.1.0. */
const AUDIT_OPTIONS_0_1_0 = [
  '--checkpoint',
  '--dir',
  '--help',
  '--json',
  '--outcome',
  '--page',
  '--since',
  '--type',
  '--until',
  '--user',
  '--verify',
];

function sourceOf(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true);
}

/** The member names of an exported interface, in order. */
function handleMembers(): string[] {
  const path = 'packages/adapter/src/core.ts';
  const found = sourceOf(path).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'Dock',
  );
  if (found === undefined) throw new Error(`${path} declares no Dock`);
  return found.members.flatMap((member) =>
    member.name !== undefined && ts.isIdentifier(member.name) ? [member.name.text] : [],
  );
}

/** Every value, never a type, the adapter's entry exports by name. */
function adapterValues(): string[] {
  const names: string[] = [];
  for (const statement of sourceOf('packages/adapter/src/index.ts').statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) names.push(element.name.text);
        }
      }
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

/** The options the audit reader's usage text lists. */
function auditOptions(): string[] {
  const source = readRepo('packages/relay/src/audit-cli.ts');
  return [...new Set([...source.matchAll(/^ {2}(--[a-z-]+)/gm)].map((match) => match[1] ?? ''))];
}

describe('the CHANGELOG', () => {
  const changelog = readRepo('CHANGELOG.md');

  it('reads the surfaces it checks, 0.1.0 within each', () => {
    expect(handleMembers()).toEqual(expect.arrayContaining(HANDLE_0_1_0));
    expect(adapterValues()).toEqual(expect.arrayContaining(ADAPTER_VALUES_0_1_0));
    expect(auditOptions()).toEqual(expect.arrayContaining(AUDIT_OPTIONS_0_1_0));
  });

  it('names every control handle member added since 0.1.0 as dock.<member>', () => {
    const missing = handleMembers()
      .filter((name) => !HANDLE_0_1_0.includes(name))
      .filter((name) => !changelog.includes(`\`dock.${name}(`));
    expect(missing).toEqual([]);
  });

  it('names every value the adapter exports since 0.1.0', () => {
    const missing = adapterValues()
      .filter((name) => !ADAPTER_VALUES_0_1_0.includes(name))
      .filter((name) => !changelog.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it('names every option the audit reader gained since 0.1.0', () => {
    const missing = auditOptions()
      .filter((option) => !AUDIT_OPTIONS_0_1_0.includes(option))
      .filter((option) => !changelog.includes(`\`${option}`) && !changelog.includes(` ${option} `));
    expect(missing).toEqual([]);
  });
});
