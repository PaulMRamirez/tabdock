// The walk (ADR 0041): through a Tabdock relay, every stop of every
// walkthrough and every observation of a page that follows the map profile,
// checking that each lands where it says and that the state the page
// publishes (ADR 0040) follows it. It is the one walker this repository
// keeps; a copier's page is held to the same checks.
//
// It reads every result from after the relay's label with the copied
// schemas, and collects findings rather than stopping at the first, so one
// bad stop never hides the rest. A finding holds ids, numbers and the
// relay's own words only, never a page's text, since a CI log is read by
// people and tools that should not meet page content (S10).

import { z } from 'zod';
import { type ResultLike, readResult } from './labelled.ts';
import {
  CaptureImageTextSchema,
  GLOBE,
  GoToStopResultSchema,
  ListObservationsResultSchema,
  ListWalkthroughsResultSchema,
  MAP_MAX_OBSERVATIONS,
  MapClockSchema,
  type MapPageState,
  MapPageStateSchema,
  MapObservationSchema,
  MapStopSchema,
  MapViewSchema,
  ViewFromObservationResultSchema,
} from './profile.ts';

/** One relay tool call: list_pages, list_page_tools, call_page_tool, get_page_state or wait_for_page_state. */
export type Caller = (tool: string, args: Record<string, unknown>) => Promise<ResultLike>;

/** Something a stop or an observation did not do. Ids, numbers and relay words only. */
export interface Finding {
  /** The walkthrough's id, or null for a check of the page or of an observation. */
  readonly walkthrough: string | null;
  readonly stop: number | null;
  readonly observation: string | null;
  /** Which check: tools, role, result, view, clock, state, state-view, state-clock, viewpoint, capture. */
  readonly check: string;
  readonly expected: string;
  readonly got: string;
}

export interface WalkOptions {
  /** Runs one stop's or observation's checks; the spec passes test.step, so each shows in its report. */
  readonly step?: (title: string, body: () => Promise<void>) => Promise<void>;
  /** Told the walk's size before its first stop, so the spec can size its timeout. */
  readonly planned?: (size: { stops: number; observations: number }) => void;
  /** How long published state may take to follow a move: 5 s unless set. */
  readonly stateTimeoutMs?: number;
  /** The largest image a capture may be, in bytes: 65,536, the relay's default, unless set. */
  readonly maxImageBytes?: number;
}

/** Angles within this many degrees, and metres within this fraction, count as the same (ADR 0041, decision 14). */
export const ANGLE_TOLERANCE_DEG = 1e-6;
export const RELATIVE_TOLERANCE = 1e-6;
const DEFAULT_STATE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_IMAGE_BYTES = 65_536;
/** One wait at most this long, so a slow page still leaves time for another read. */
const WAIT_SLICE_MS = 2_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The tools the walk needs; without them there is nothing to walk. */
const REQUIRED_TOOLS = ['get_view', 'list_walkthroughs', 'get_stop', 'go_to_stop'] as const;
/** Each optional group is checked when the page registers it whole (ADR 0038, decision 2). */
const OBSERVATION_TOOLS = ['list_observations', 'get_observation', 'view_from_observation'];

/** list_pages after the label: the walk needs only the page's id and the caller's role. */
const PagesSchema = z.object({
  pages: z.array(z.object({ page: z.string(), role: z.string() })),
});
/** list_page_tools after the label: names only. */
const ToolsSchema = z.object({ tools: z.array(z.object({ name: z.string() })) });
/** get_page_state and wait_for_page_state after the label (ADR 0040). */
const StateBodySchema = z.object({
  version: z.int().min(0),
  value: z.unknown(),
  changed: z.boolean().optional(),
});

/** Fields whose values are angles: compared round the circle, so -180 and 180 are one longitude. */
const CIRCULAR = new Set(['lon', 'headingDeg', 'west', 'east']);
/** Fields in degrees; every other number is a distance or a count, compared relatively. */
const DEGREES = new Set([
  'lon',
  'lat',
  'headingDeg',
  'pitchDeg',
  'fovDeg',
  'west',
  'east',
  'south',
  'north',
]);

function sameNumber(field: string, a: number, b: number): boolean {
  if (DEGREES.has(field)) {
    const apart = Math.abs(a - b);
    return (CIRCULAR.has(field) ? Math.min(apart, 360 - apart) : apart) <= ANGLE_TOLERANCE_DEG;
  }
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b), 1);
}

/** A value for a finding: numbers, flags and id-shaped words as they are, and never other page text. */
function shown(value: unknown): string {
  if (value === undefined) return 'absent';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
      ? value
      : `text of ${String(value.length)} characters`;
  }
  return Array.isArray(value) ? 'a list' : 'an object';
}

/**
 * The first field, by path, where `got` differs from `expected`, as two
 * short strings, or null when they agree: numbers within the tolerances,
 * everything else exactly. Only `fields` are compared when given.
 */
export function difference(
  expected: unknown,
  got: unknown,
  fields?: readonly string[],
  path = '',
): { expected: string; got: string } | null {
  if (typeof expected === 'number' && typeof got === 'number') {
    const field = path.split('.').at(-1) ?? '';
    return sameNumber(field, expected, got)
      ? null
      : { expected: `${path}=${shown(expected)}`, got: `${path}=${shown(got)}` };
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (isObject(expected) && isObject(got)) {
    const keys = fields ?? [...new Set([...Object.keys(expected), ...Object.keys(got)])].sort();
    for (const key of keys) {
      const found = difference(
        expected[key],
        got[key],
        undefined,
        path === '' ? key : `${path}.${key}`,
      );
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(got)) {
    if (expected.length !== got.length) {
      return {
        expected: `${path}.length=${String(expected.length)}`,
        got: `${path}.length=${String(got.length)}`,
      };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const found = difference(expected[index], got[index], undefined, `${path}[${String(index)}]`);
      if (found) return found;
    }
    return null;
  }
  return Object.is(expected, got)
    ? null
    : { expected: `${path}=${shown(expected)}`, got: `${path}=${shown(got)}` };
}

/** Thrown inside a step to end it with one finding; the walk goes on with the next step. */
class Stop extends Error {
  readonly finding: Omit<Finding, 'walkthrough' | 'stop' | 'observation'>;

  constructor(finding: Omit<Finding, 'walkthrough' | 'stop' | 'observation'>) {
    super(finding.check);
    this.finding = finding;
  }
}

/** One schema's parse of a result, or a 'result' finding naming the tool and why. */
async function read<T>(
  calling: Promise<ResultLike>,
  tool: string,
  schema: z.ZodType<T>,
): Promise<{ body: T; image: { mimeType: string; data: string } | null }> {
  const outcome = readResult(await calling);
  if (!outcome.ok)
    throw new Stop({ check: 'result', expected: `${tool} answered`, got: outcome.why });
  const parsed = schema.safeParse(outcome.read.body);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    throw new Stop({
      check: 'result',
      expected: `${tool} in the profile's shape`,
      got: `not at ${path || '(root)'}`,
    });
  }
  return { body: parsed.data, image: outcome.read.image };
}

/**
 * Walks the page `pageId` through `call`, a caller already attached to it
 * as driver, and returns what it found: empty when every stop and
 * observation held.
 */
export async function walkPage(
  call: Caller,
  pageId: string,
  options: WalkOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const step = options.step ?? ((_title: string, body: () => Promise<void>) => body());
  const stateTimeoutMs = options.stateTimeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const page = (tool: string, args: Record<string, unknown> = {}): Promise<ResultLike> =>
    call('call_page_tool', { page: pageId, tool, arguments: args });

  /** Runs checks for one place, turning a Stop into its finding. */
  const place = async (
    where: Pick<Finding, 'walkthrough' | 'stop' | 'observation'>,
    title: string,
    body: (
      note: (finding: Omit<Finding, 'walkthrough' | 'stop' | 'observation'>) => void,
    ) => Promise<void>,
  ): Promise<void> => {
    const note = (finding: Omit<Finding, 'walkthrough' | 'stop' | 'observation'>): void => {
      findings.push({ ...where, ...finding });
    };
    await step(title, async () => {
      try {
        await body(note);
      } catch (error) {
        if (!(error instanceof Stop)) throw error;
        note(error.finding);
      }
    });
  };

  /** The page's state once `wanted` holds of it, read and then waited on, or null at the deadline. */
  const stateWhen = async (
    wanted: (state: MapPageState) => boolean,
  ): Promise<MapPageState | null> => {
    const deadline = Date.now() + stateTimeoutMs;
    let body = (
      await read(call('get_page_state', { page: pageId }), 'get_page_state', StateBodySchema)
    ).body;
    for (;;) {
      const state = MapPageStateSchema.safeParse(body.value);
      if (state.success && wanted(state.data)) return state.data;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      body = (
        await read(
          call('wait_for_page_state', {
            page: pageId,
            after: body.version,
            timeoutMs: Math.min(left, WAIT_SLICE_MS),
          }),
          'wait_for_page_state',
          StateBodySchema,
        )
      ).body;
    }
  };

  // The page, as the relay lists it to this caller, and the tools it has.
  let tools: Set<string>;
  try {
    const pages = (await read(call('list_pages', {}), 'list_pages', PagesSchema)).body;
    const listed = pages.pages.find((entry) => entry.page === pageId);
    if (listed?.role !== 'driver') {
      findings.push({
        walkthrough: null,
        stop: null,
        observation: null,
        check: 'role',
        expected: 'driver',
        got: listed?.role ?? 'not attached',
      });
      return findings;
    }
    const listing = (
      await read(call('list_page_tools', { page: pageId }), 'list_page_tools', ToolsSchema)
    ).body;
    tools = new Set(listing.tools.map((tool) => tool.name));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    findings.push({ walkthrough: null, stop: null, observation: null, ...error.finding });
    return findings;
  }
  const missing = REQUIRED_TOOLS.filter((name) => !tools.has(name));
  for (const name of missing) {
    findings.push({
      walkthrough: null,
      stop: null,
      observation: null,
      check: 'tools',
      expected: name,
      got: 'not listed',
    });
  }
  if (missing.length > 0) return findings;
  const hasClock = tools.has('get_clock');
  const hasCapture = tools.has('capture_view');
  const hasObservations = OBSERVATION_TOOLS.every((name) => tools.has(name));

  let walkthroughs: { id: string; stopCount: number }[];
  let observations: string[] = [];
  try {
    walkthroughs = (
      await read(page('list_walkthroughs'), 'list_walkthroughs', ListWalkthroughsResultSchema)
    ).body.walkthroughs;
    if (hasObservations) observations = await listObservations();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    findings.push({ walkthrough: null, stop: null, observation: null, ...error.finding });
    return findings;
  }
  options.planned?.({
    stops: walkthroughs.reduce((sum, walkthrough) => sum + walkthrough.stopCount, 0),
    observations: observations.length,
  });

  /**
   * Every observation's id, oldest first. The profile has no cursor, so a
   * list cut at its cap of 150 goes on from the last time it held.
   */
  async function listObservations(): Promise<string[]> {
    const ids: string[] = [];
    let from: string | undefined;
    for (;;) {
      const listed = (
        await read(
          page('list_observations', {
            limit: MAP_MAX_OBSERVATIONS,
            ...(from === undefined ? {} : { from }),
          }),
          'list_observations',
          ListObservationsResultSchema,
        )
      ).body;
      const fresh = listed.observations.filter((observation) => !ids.includes(observation.id));
      ids.push(...fresh.map((observation) => observation.id));
      if (!listed.truncated) return ids;
      const last = listed.observations.at(-1);
      if (fresh.length === 0 || last === undefined) {
        throw new Stop({
          check: 'result',
          expected: 'list_observations to go on past its cap',
          got: `stuck at ${String(ids.length)}`,
        });
      }
      from = last.time;
    }
  }

  for (const walkthrough of walkthroughs) {
    for (let index = 0; index < walkthrough.stopCount; index += 1) {
      await place(
        { walkthrough: walkthrough.id, stop: index, observation: null },
        `${walkthrough.id} stop ${String(index)}`,
        async (note) => {
          const moved = (
            await read(
              page('go_to_stop', { walkthroughId: walkthrough.id, index }),
              'go_to_stop',
              GoToStopResultSchema,
            )
          ).body;
          const stop = (
            await read(
              page('get_stop', { walkthroughId: walkthrough.id, index }),
              'get_stop',
              MapStopSchema,
            )
          ).body;
          const view = (await read(page('get_view'), 'get_view', MapViewSchema)).body;
          const off = difference(stop.view, view, Object.keys(stop.view));
          if (off) note({ check: 'view', ...off });
          let clock: z.infer<typeof MapClockSchema> | null = null;
          if (hasClock) {
            clock = (await read(page('get_clock'), 'get_clock', MapClockSchema)).body;
            if (stop.clock) {
              const expected = { rate: stop.clock.rate, playing: stop.clock.playing };
              const late = difference(expected, { rate: clock.rate, playing: clock.playing });
              if (late) note({ check: 'clock', ...late });
              // A playing clock has moved on since the stop set it.
              if (!stop.clock.playing && Date.parse(stop.clock.time) !== Date.parse(clock.time)) {
                note({
                  check: 'clock',
                  expected: `time=${String(Date.parse(stop.clock.time))}`,
                  got: `time=${String(Date.parse(clock.time))}`,
                });
              }
            }
          }
          const state = await stateWhen(
            (published) =>
              published.walkthrough?.id === walkthrough.id &&
              published.walkthrough.stopIndex === index,
          );
          if (state === null) {
            note({
              check: 'state',
              expected: `walkthrough ${walkthrough.id} stop ${String(index)}`,
              got: `none within ${String(stateTimeoutMs)} ms`,
            });
          } else {
            const stateView = difference(view, state.view);
            if (stateView) note({ check: 'state-view', ...stateView });
            if (clock !== null && state.clock !== null && !clock.playing) {
              const stateClock = difference(clock, state.clock);
              if (stateClock) note({ check: 'state-clock', ...stateClock });
            }
            if (state.observationId !== moved.observationId) {
              note({
                check: 'state',
                expected: `observationId=${shown(moved.observationId)}`,
                got: `observationId=${shown(state.observationId)}`,
              });
            }
          }
          if (hasCapture) await checkCapture(view, note);
        },
      );
    }
  }

  for (const id of observations) {
    await place(
      { walkthrough: null, stop: null, observation: id },
      `observation ${id}`,
      async (note) => {
        const observation = (
          await read(page('get_observation', { id }), 'get_observation', MapObservationSchema)
        ).body;
        const moved = (
          await read(
            page('view_from_observation', { id }),
            'view_from_observation',
            ViewFromObservationResultSchema,
          )
        ).body;
        const view = (await read(page('get_view'), 'get_view', MapViewSchema)).body;
        if (moved.observationId !== id) {
          note({
            check: 'viewpoint',
            expected: `observationId=${id}`,
            got: `observationId=${moved.observationId}`,
          });
        }
        // On a globe every viewpoint field is the camera's; a 2D map has no altitude or field of view.
        const { viewpoint } = observation;
        const fields =
          view.projection === GLOBE
            ? Object.keys(viewpoint)
            : ['body', 'lon', 'lat', 'headingDeg', 'pitchDeg'];
        const off = difference(viewpoint, view, fields);
        if (off) note({ check: 'viewpoint', ...off });
        // The state from the last stop may already name this observation, so
        // only a state at the view on screen now counts as following the move.
        const state = await stateWhen(
          (published) =>
            published.observationId === id && difference(view, published.view) === null,
        );
        if (state === null) {
          note({
            check: 'state',
            expected: `observationId=${id} at the view get_view gives`,
            got: `none within ${String(stateTimeoutMs)} ms`,
          });
        }
      },
    );
  }
  return findings;

  /** capture_view returns one PNG within the cap, beside text whose view is the one on screen. */
  async function checkCapture(
    view: z.infer<typeof MapViewSchema>,
    note: (finding: Omit<Finding, 'walkthrough' | 'stop' | 'observation'>) => void,
  ): Promise<void> {
    const outcome = readResult(await page('capture_view', { format: 'png' }));
    if (!outcome.ok)
      throw new Stop({ check: 'result', expected: 'capture_view answered', got: outcome.why });
    const { image, body } = outcome.read;
    if (image === null) {
      note({ check: 'capture', expected: 'an image/png part', got: 'none' });
      return;
    }
    // The picture is checked for its type and size only; judging it is the advisory walk's.
    const bytes = Buffer.from(image.data, 'base64');
    const png = PNG_SIGNATURE.every((value, at) => bytes[at] === value);
    if (image.mimeType !== 'image/png' || !png) {
      note({ check: 'capture', expected: 'image/png', got: png ? image.mimeType : 'not a PNG' });
    } else if (bytes.length > maxImageBytes) {
      note({
        check: 'capture',
        expected: `at most ${String(maxImageBytes)} bytes`,
        got: `${String(bytes.length)} bytes`,
      });
    }
    const words = CaptureImageTextSchema.safeParse(body);
    const off = words.success
      ? difference(view, words.data.view)
      : { expected: "the view as the profile's JSON text", got: 'not in that shape' };
    if (off) note({ check: 'capture', ...off });
  }
}
