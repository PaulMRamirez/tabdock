// Guide page 16 against the profile's source (ADR 0038): its tool table is
// MAP_PROFILE_TOOLS by name, group and annotation, each interface in its
// shapes block has the keys and optional markers of the zod schema a client
// would parse with, its limits are the MAP_* constants, its policy example
// names the tools MAP_PAGE_POLICY names, and its published state example is
// one MapPageStateSchema accepts. A rename, a new field or a changed cap in
// the code fails here until the page says the same.

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as profile from '@tabdock/sim-page/map';
import { codeBlocks, readRepo, tables } from '../src/doc-files.ts';

const PAGE = 'docs/guide/16-map-pages.md';
const text = readRepo(PAGE);

interface ObjectSchema {
  readonly shape: Readonly<Record<string, { safeParse(value: unknown): { success: boolean } }>>;
}

/** Each interface the page shows, and the schema whose keys it must have. */
const SHAPES: Record<string, ObjectSchema> = {
  MapView: profile.MapViewSchema,
  MapClock: profile.MapClockSchema,
  MapLayer: profile.MapLayerSchema,
  MapFeature: profile.MapFeatureSchema,
  WalkthroughSummary: profile.WalkthroughSummarySchema,
  MapStop: profile.MapStopSchema,
  ObservationSummary: profile.ObservationSummarySchema,
  MapViewpoint: profile.MapViewpointSchema,
  MapObservation: profile.MapObservationSchema,
  MapPageState: profile.MapPageStateSchema,
  ListWalkthroughsResult: profile.ListWalkthroughsResultSchema,
  GoToStopResult: profile.GoToStopResultSchema,
  ViewFromObservationResult: profile.ViewFromObservationResultSchema,
  CaptureViewText: profile.CaptureImageTextSchema,
  CaptureViewDescription: profile.CaptureTextSchema,
};

/** Each key of a schema's shape, with ? where the key may be left out, which is where it takes undefined. */
function schemaKeys(schema: ObjectSchema): string[] {
  return Object.entries(schema.shape)
    .map(([key, field]) => (field.safeParse(undefined).success ? `${key}?` : key))
    .sort();
}

/** Each interface declared in the page's ts blocks, with its keys and ? markers. */
function pageInterfaces(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const block of codeBlocks(text).filter((candidate) => candidate.lang === 'ts')) {
    const source = ts.createSourceFile('shapes.ts', block.body, ts.ScriptTarget.ES2022, true);
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement)) continue;
      const keys = statement.members.flatMap((member) =>
        ts.isPropertySignature(member) && ts.isIdentifier(member.name)
          ? [`${member.name.text}${member.questionToken ? '?' : ''}`]
          : [],
      );
      found.set(statement.name.text, keys.sort());
    }
  }
  return found;
}

/** The argument names a cell gives in code spans: identifiers, not quoted values such as 'png'. */
function namesIn(cell: string): string[] {
  return [...cell.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((match) => match[1] ?? '');
}

/** The keys a tool's argument schema takes. */
function inputKeys(tool: string): string[] {
  const inputs = profile.mapInputs() as unknown as Record<string, { shape: object } | undefined>;
  return Object.keys(inputs[tool]?.shape ?? {}).sort();
}

/** Every whole number a cell states, commas and units dropped. */
function numbersIn(cell: string): number[] {
  return [...cell.matchAll(/\d[\d,]*/g)].map((match) => Number(match[0].replace(/,/g, '')));
}

/** The constants a cell names in code spans. */
function constantsIn(cell: string): string[] {
  return [...cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1] ?? '');
}

describe('guide page 16, map and globe pages', () => {
  it("lists each profile tool with its group and annotation, in the profile's order", () => {
    const table = tables(text).find((candidate) => candidate.header.includes('Annotation'));
    expect(table?.header).toEqual(['Group', 'Tool', 'Annotation', 'Arguments', 'Returns']);
    const rows = (table?.rows ?? []).map(({ cells }) => ({
      group: cells.Group,
      name: (cells.Tool ?? '').replace(/`/g, ''),
      annotation: cells.Annotation,
    }));
    expect(rows).toEqual(
      profile.MAP_PROFILE_TOOLS.map((tool) => ({
        group: tool.group,
        name: tool.name,
        annotation: tool.readOnly
          ? tool.untrustedContent
            ? 'read-only, untrusted content'
            : 'read-only'
          : 'write',
      })),
    );
  });

  it('names each argument in code, exactly as the tool takes it, and every one it takes', () => {
    const table = tables(text).find((candidate) => candidate.header.includes('Annotation'));
    const viewKeys = Object.keys(profile.MapViewSchema.shape);
    const problems = (table?.rows ?? []).flatMap(({ cells }) => {
      const tool = (cells.Tool ?? '').replace(/`/g, '');
      const named = namesIn(cells.Arguments ?? '');
      const keys = inputKeys(tool);
      // set_view takes "any of the view's fields but profile and bounds", naming those two by the view's keys.
      const unknown = named.filter(
        (name) => !keys.includes(name) && !(tool === 'set_view' && viewKeys.includes(name)),
      );
      const unnamed = tool === 'set_view' ? [] : keys.filter((key) => !named.includes(key));
      return [
        ...unknown.map((name) => `${tool} takes no ${name}`),
        ...unnamed.map((key) => `${tool}'s ${key} is not named in code`),
      ];
    });
    expect(problems).toEqual([]);
    // The rule would catch an argument left as plain words, as the table once gave them.
    expect(namesIn('id, with visible or opacity')).toEqual([]);
    expect(namesIn("`format` `'png'` or `'jpeg'`")).toEqual(['format']);
  });

  it("gives set_view's example a description that names exactly the fields its schema takes", () => {
    const example = codeBlocks(text).find((block) => block.body.includes("name: 'set_view'"));
    const body = example?.body.slice(example.body.indexOf("name: 'set_view'")) ?? '';
    const description = /description:\s*'([^']*)'/.exec(body)?.[1] ?? '';
    const properties = /properties: \{([\s\S]*?)\n {4}\},/.exec(body)?.[1] ?? '';
    const keys = [...properties.matchAll(/^\s+([A-Za-z]+):/gm)].map((match) => match[1] ?? '');
    expect(keys.length).toBeGreaterThan(0);
    const fields = Object.keys(profile.MapViewSchema.shape);
    const said = fields.filter((field) => new RegExp(`\\b${field}\\b`).test(description));
    expect(said.sort()).toEqual([...keys].sort());
  });

  it('shows each result shape with the keys and optional markers of its schema', () => {
    const shown = pageInterfaces();
    expect([...shown.keys()].sort()).toEqual(Object.keys(SHAPES).sort());
    for (const [name, schema] of Object.entries(SHAPES)) {
      expect(shown.get(name), name).toEqual(schemaKeys(schema));
    }
    // The comparison tells an optional key from a nullable one.
    expect(schemaKeys(profile.MapViewSchema)).toContain('altitudeM?');
    expect(schemaKeys(profile.MapViewSchema)).toContain('bounds');
  });

  it('states each limit as the constant behind it', () => {
    const table = tables(text).find((candidate) => candidate.header.includes('Constant'));
    expect(table?.header).toEqual(['Limit', 'Value', 'Constant']);
    const constants = profile as unknown as Record<string, unknown>;
    const stated = (table?.rows ?? []).flatMap(({ cells }) => {
      const names = constantsIn(cells.Constant ?? '');
      const values = numbersIn(cells.Value ?? '');
      expect(values, cells.Limit).toHaveLength(names.length);
      return names.map((name, index) => [name, values[index]] as const);
    });
    for (const [name, value] of stated) expect(constants[name], name).toBe(value);
    // Every cap the profile names, but the distance, rate and capture text caps the schemas hold.
    const named = new Set(stated.map(([name]) => name));
    const caps = Object.keys(profile).filter(
      (key) =>
        /^MAP_(?:MAX|MIN|DEFAULT)_/.test(key) &&
        ![
          'MAP_MAX_DISTANCE_M',
          'MAP_MAX_RATE',
          'MAP_MAX_URL_CHARS',
          'MAP_MAX_CAPTURE_DESCRIPTION_CHARS',
          'MAP_MAX_CALLS_KEPT',
          'MAP_DEFAULT_FOV_DEG',
        ].includes(key),
    );
    expect(caps.filter((key) => !named.has(key))).toEqual([]);
  });

  it('names in its policy example the tools MAP_PAGE_POLICY names, and capture_view as its image tool', () => {
    const example = codeBlocks(text).find(
      (block) => block.lang === 'ts' && block.body.includes('attach('),
    );
    const listed = (name: string): string[] =>
      [
        ...(new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(example?.body ?? '')?.[1] ?? '').matchAll(
          /'([^']+)'/g,
        ),
      ].map((match) => match[1] ?? '');
    expect(listed('consequentialTools')).toEqual([...profile.MAP_PAGE_POLICY.consequentialTools]);
    expect(listed('imageTools')).toEqual(['capture_view']);
  });

  it('gives a published state example the schema accepts', () => {
    const example = codeBlocks(text).find((block) => block.lang === 'json');
    const parsed = profile.MapPageStateSchema.safeParse(JSON.parse(example?.body ?? 'null'));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.view.profile).toBe(profile.MAP_PROFILE);
  });

  it('names the profile marker and the description cap the code uses', () => {
    expect(text).toContain(`\`profile: '${profile.MAP_PROFILE}'\``);
    expect(text).toContain(
      `one ASCII line of at most ${String(profile.MAP_MAX_DESCRIPTION_CHARS)} characters`,
    );
  });
});
