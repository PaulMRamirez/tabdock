// The adapter reference (docs/guide/04-adapter-reference.md, ADR 0035) and
// the control handle page it sends readers on to (13-the-control-handle.md,
// which took the handle's tables when M6 grew them) are where a page author
// looks up an option, a policy field or a handle method, so each of their
// tables must list exactly what the code declares: the members of
// AttachOptions, Dock, DockState and InviteOptions as the TypeScript sources
// declare them, PolicySchema's fields, and the data-* attributes the
// script-tag build reads. The policy's defaults must be what
// PolicySchema fills in, every value the page lists must parse, and the
// stated range for maxDrivers must be the schema's. The adapter README's
// at-a-glance paragraph names the same handle members.

import { PolicySchema } from '@tabdock/protocol';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { INVITE_LIFETIMES } from '../../../packages/adapter/src/core.ts';
import { readScriptOptions } from '../../../packages/adapter/src/script-options.ts';
import { datasetKey, readRepo, scriptTagAttributes, type Table, tables } from '../src/doc-files.ts';

const PAGE = 'docs/guide/04-adapter-reference.md';
const HANDLE = 'docs/guide/13-the-control-handle.md';

/** The member names an interface declares in a source file, in order. */
function membersOf(path: string, name: string): string[] {
  const source = ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true);
  const found = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (found === undefined) throw new Error(`${path} declares no interface ${name}`);
  return found.members.flatMap((member) =>
    member.name !== undefined && ts.isIdentifier(member.name) ? [member.name.text] : [],
  );
}

/** The table whose first header cell is `first`. */
function tableHeaded(all: readonly Table[], first: string): Table {
  const table = all.find((candidate) => candidate.header[0] === first);
  if (table === undefined)
    throw new Error(`neither ${PAGE} nor ${HANDLE} has a table headed ${first}`);
  return table;
}

/** A first-column cell's backticked name: `name` alone. */
function firstNames(table: Table): string[] {
  return table.rows.map(
    (row) => /^`([^`]+)`$/.exec(row.values[0] ?? '')?.[1] ?? row.values[0] ?? '',
  );
}

/** The 'quoted' values in a cell's code spans, such as `'none'` or `'observer'`. */
function quotedValues(cell: string): string[] {
  return [...cell.matchAll(/`'([^'`]+)'`/g)].map((match) => match[1] ?? '');
}

/** A cell's code spans, unquoted: `none` or `observer` gives none and observer. */
function spanValues(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').replace(/^'|'$/g, ''));
}

/** `'none'` as 'none', `1` as 1, `[]` as []: a Default cell as a value. */
function cellValue(cell: string): unknown {
  const span = /^`([^`]+)`$/.exec(cell.trim())?.[1];
  if (span === undefined) return undefined;
  return JSON.parse(span.replaceAll("'", '"')) as unknown;
}

/** The two whole numbers of a stated range: "an integer from 1 to 100" gives [1, 100]. */
function rangeOf(cell: string): [number, number] | null {
  const match = /(\d+) to (\d+)/.exec(cell);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

/** The enum options a policy field takes, read from the schema itself. */
function enumOptions(field: keyof typeof PolicySchema.shape): string[] | null {
  const inner: unknown = Reflect.get(PolicySchema.shape[field].def, 'innerType');
  const options: unknown =
    typeof inner === 'object' && inner !== null ? Reflect.get(inner, 'options') : undefined;
  return Array.isArray(options) ? options.map(String) : null;
}

describe('the adapter reference', () => {
  // Each table is looked for on both pages, so it may move between them, but
  // never be on neither nor (by its header) on both.
  const all = [...tables(readRepo(PAGE)), ...tables(readRepo(HANDLE))];

  it('holds each of its tables once across the two pages', () => {
    const headers = all.map((table) => table.header[0]);
    expect(headers.filter((header, index) => headers.indexOf(header) !== index)).toEqual([]);
  });

  it('lists every attach() option and no other', () => {
    expect(firstNames(tableHeaded(all, 'Option'))).toEqual(
      membersOf('packages/adapter/src/index.ts', 'AttachOptions'),
    );
  });

  it('lists every member of the handle, of its state and of invite options', () => {
    const core = 'packages/adapter/src/core.ts';
    expect(firstNames(tableHeaded(all, 'Member'))).toEqual(membersOf(core, 'Dock'));
    expect(firstNames(tableHeaded(all, '`DockState` field'))).toEqual(membersOf(core, 'DockState'));
    expect(firstNames(tableHeaded(all, '`InviteOptions` field'))).toEqual(
      membersOf(core, 'InviteOptions'),
    );
  });

  it('lists every invite lifetime the adapter takes', () => {
    const lifetime = tableHeaded(all, '`InviteOptions` field').rows.find(
      (row) => row.values[0] === '`lifetime`',
    );
    expect(quotedValues(lifetime?.values[1] ?? '')).toEqual([...INVITE_LIFETIMES]);
  });

  describe('policy table', () => {
    const policy = tableHeaded(all, 'Field');
    const fields = Object.keys(PolicySchema.shape) as (keyof typeof PolicySchema.shape)[];

    it('lists every PolicySchema field and no other, with its script attribute', () => {
      expect(firstNames(policy)).toEqual(fields);
      const attributes = policy.rows.map(
        (row) => /`(data-[a-z-]+)`/.exec(row.cells['Script tag'] ?? '')?.[1],
      );
      const expected = fields.map(
        (field) => `data-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      );
      expect(attributes).toEqual(expected);
    });

    it('states the defaults PolicySchema fills in', () => {
      const defaults: Record<string, unknown> = Object.fromEntries(
        policy.rows.map((row, index): [string, unknown] => [
          fields[index] ?? '',
          cellValue(row.cells.Default ?? ''),
        ]),
      );
      expect(defaults).toEqual(PolicySchema.parse({}));
    });

    it('lists exactly the values each enum field takes, each of which parses', () => {
      const problems = policy.rows.flatMap((row, index) => {
        const field = fields[index];
        if (field === undefined) return [`row ${String(index)} has no field`];
        const options = enumOptions(field);
        if (options === null) return [];
        const listed = quotedValues(row.cells.Type ?? '');
        const refused = listed.filter(
          (value) => !PolicySchema.safeParse({ [field]: value }).success,
        );
        return [
          ...refused.map((value) => `${field}: '${value}' does not parse`),
          ...(listed.join() === options.join()
            ? []
            : [`${field}: lists ${listed.join(', ')}, the schema takes ${options.join(', ')}`]),
        ];
      });
      expect(problems).toEqual([]);
    });

    it('states the range maxDrivers takes', () => {
      const row = policy.rows.find((candidate) => candidate.values[0] === '`maxDrivers`');
      const range = rangeOf(row?.cells.Type ?? '');
      expect(range).not.toBeNull();
      const [least, most] = range ?? [0, 0];
      const parses = (maxDrivers: number): boolean =>
        PolicySchema.safeParse({ maxDrivers }).success;
      expect([parses(least - 1), parses(least), parses(most), parses(most + 1)]).toEqual([
        false,
        true,
        true,
        false,
      ]);
    });
  });

  describe('script tag table', () => {
    const table = tableHeaded(all, 'Attribute');

    it('lists every attribute the script-tag build reads and no other', () => {
      expect([...firstNames(table)].sort()).toEqual(scriptTagAttributes());
    });

    it('lists values the build accepts, and a range it holds to', () => {
      const relay = { relay: 'ws://127.0.0.1:8787/page' };
      const problems = table.rows.flatMap((row) => {
        const attribute = firstNames({ header: [], rows: [row], line: 0 })[0] ?? '';
        if (attribute === 'data-relay') return [];
        const key = datasetKey(attribute);
        const range = rangeOf(row.cells.Value ?? '');
        const values = range === null ? spanValues(row.cells.Value ?? '') : range.map(String);
        const refused = values.filter((value) => !readScriptOptions({ ...relay, [key]: value }).ok);
        const outside =
          range === null
            ? []
            : [range[0] - 1, range[1] + 1].filter(
                (value) => readScriptOptions({ ...relay, [key]: String(value) }).ok,
              );
        return [
          ...refused.map((value) => `${attribute}="${value}" is refused`),
          ...outside.map(
            (value) => `${attribute}="${String(value)}" is accepted outside the range`,
          ),
        ];
      });
      expect(problems).toEqual([]);
    });
  });
});

describe("the adapter README's at-a-glance paragraph", () => {
  it('names the same handle members as Dock declares', () => {
    const readme = readRepo('packages/adapter/README.md');
    const sentence = /whose members are ([^.]+)\./.exec(readme)?.[1] ?? '';
    const named = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    expect(named).toEqual(membersOf('packages/adapter/src/core.ts', 'Dock'));
  });
});
