// The profile's tools over a MapWorld, as a page registers them through
// WebMCP. Each handler notes its run, then parses its arguments with the
// same zod schema clients were shown and throws on anything it refuses, so
// the call ends as tool_error: the relay's check is advisory and drops
// pattern and format, and a refusal returned as an ok result would pass a
// walk silently. A refusal names schema paths and fixed words, never what
// the caller sent.

import type { z } from 'zod';
import type { FakeToolDefinition, FakeToolExecuteOptions } from '../fake-model-context.ts';
import {
  MAP_DEFAULT_CAPTURE_WIDTH_PX,
  MAP_EDIT_TOOLS,
  MAP_MAX_CAPTURE_DESCRIPTION_CHARS,
  MAP_PROFILE_TOOLS,
  MAP_TOOL_GROUPS,
  mapAnnotations,
  mapInputs,
  type MapEditToolName,
  type MapInputs,
  type MapToolGroup,
  type MapToolInfo,
  type MapToolName,
  toInputSchema,
} from './profile.ts';
import type { MapWorld } from './world.ts';

/** A tool as a page registers it: WebMCP's shape, which the sim page's fake runtime takes too. */
export type MapToolDefinition = FakeToolDefinition;

export interface MapCaptureRequest {
  readonly maxWidthPx: number;
  readonly format: 'png' | 'jpeg';
}

export interface MapCaptured {
  readonly mimeType: 'image/png' | 'image/jpeg';
  /** Bare base64. */
  readonly data: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** How a page reads its own drawing; with one, capture_view returns ADR 0039's envelope. */
export type MapCapture = (
  request: MapCaptureRequest,
  options: { signal?: AbortSignal | undefined },
) => Promise<MapCaptured>;

export interface MapToolOptions {
  readonly capture?: MapCapture | undefined;
  /**
   * The optional groups to register, each whole or not at all, so a client
   * that finds list_walkthroughs can rely on go_to_stop; every group the
   * world can serve unless set. The view group is the core and always there.
   */
  readonly groups?: readonly MapToolGroup[] | undefined;
}

type Run<S extends z.ZodType> = (args: z.output<S>, signal: AbortSignal | undefined) => unknown;

function info(name: MapToolName | MapEditToolName): MapToolInfo {
  const found = [...MAP_PROFILE_TOOLS, ...MAP_EDIT_TOOLS].find((tool) => tool.name === name);
  if (!found) throw new Error(`the map profile has no tool ${name}`);
  return found;
}

/** Paths and messages only, as the protocol's own parse reports, since arguments are the caller's. */
function refusal(name: string, error: z.ZodError): Error {
  const reasons = error.issues
    .slice(0, 3)
    .map(
      (issue) =>
        `${issue.path.join('.') || '(root)'}: ${issue.code === 'unrecognized_keys' ? 'holds fields it does not take' : issue.message}`,
    )
    .join('; ');
  return new Error(`${name} refused its arguments: ${reasons}`);
}

function define<K extends keyof MapInputs>(
  world: MapWorld,
  inputs: MapInputs,
  name: K,
  run: Run<MapInputs[K]>,
): MapToolDefinition {
  const meta = info(name);
  const input: z.ZodType = inputs[name];
  return {
    name: meta.name,
    title: meta.title,
    description: meta.description,
    inputSchema: toInputSchema(input),
    annotations: mapAnnotations(meta),
    // Always a promise, so a refusal is a rejection on every runtime, as WebMCP expects.
    execute: (raw: unknown, options?: FakeToolExecuteOptions) =>
      Promise.resolve().then(() => {
        world.record(name, raw);
        options?.signal.throwIfAborted();
        const parsed = input.safeParse(raw ?? {});
        if (!parsed.success) throw refusal(name, parsed.error);
        return run(parsed.data as z.output<MapInputs[K]>, options?.signal);
      }),
  };
}

/** capture_view's words: what a reader of the text form needs, at most 2,000 characters. */
function describeView(world: MapWorld): string {
  const view = world.view();
  const km = (view.widthM / 1000).toFixed(1);
  const layers = world.visibleLayers();
  const observation = world.observationId;
  const text = [
    `A ${view.projection} view of ${view.body} centred on latitude ${view.lat.toFixed(3)}, longitude ${view.lon.toFixed(3)}, ${km} km across,`,
    `heading ${view.headingDeg.toFixed(1)} degrees and pitch ${view.pitchDeg.toFixed(1)} degrees,`,
    `with ${String(layers.length)} of ${String(world.layers().length)} layers shown`,
    observation === null ? 'and no observation on screen.' : 'and one observation on screen.',
  ].join(' ');
  return text.slice(0, MAP_MAX_CAPTURE_DESCRIPTION_CHARS);
}

/**
 * The fourteen profile tools over `world`, in the table's order. With a
 * capture function, capture_view returns ADR 0039's envelope, one image and
 * its JSON text; without one, the text form a page that returns no images
 * gives.
 */
export function createMapTools(world: MapWorld, options: MapToolOptions = {}): MapToolDefinition[] {
  const inputs = mapInputs({ bodies: world.bodies, projections: world.projections });
  const capture = options.capture;
  const tools = [
    define(world, inputs, 'get_view', () => world.view()),
    define(world, inputs, 'set_view', (args) => world.setView(args)),
    define(world, inputs, 'capture_view', async (args, signal) => {
      const view = world.view();
      const visibleLayers = world.visibleLayers();
      const observationId = world.observationId;
      if (!capture) {
        return { description: describeView(world), view, visibleLayers, observationId };
      }
      const request = {
        maxWidthPx: args.maxWidthPx ?? MAP_DEFAULT_CAPTURE_WIDTH_PX,
        format: args.format ?? 'png',
      } as const;
      const shot = await capture(request, { signal });
      signal?.throwIfAborted();
      return {
        image: { mimeType: shot.mimeType, data: shot.data },
        text: JSON.stringify({
          view,
          visibleLayers,
          observationId,
          widthPx: shot.widthPx,
          heightPx: shot.heightPx,
        }),
      };
    }),
    define(world, inputs, 'get_clock', () => requireClock(world)),
    define(world, inputs, 'set_clock', (args) => world.setClock(args)),
    define(world, inputs, 'list_layers', () => ({ layers: world.layers() })),
    define(world, inputs, 'set_layer', (args) =>
      world.setLayer(args.id, { visible: args.visible, opacity: args.opacity }),
    ),
    define(world, inputs, 'features_in_view', (args) => world.featuresInView(args)),
    define(world, inputs, 'list_walkthroughs', () => world.walkthroughs()),
    define(world, inputs, 'get_stop', (args) => world.stop(args.walkthroughId, args.index)),
    define(world, inputs, 'go_to_stop', (args) => world.goToStop(args.walkthroughId, args.index)),
    define(world, inputs, 'list_observations', (args) => world.observations(args)),
    define(world, inputs, 'get_observation', (args) => world.observation(args.id)),
    define(world, inputs, 'view_from_observation', (args) => world.viewFromObservation(args.id)),
  ];
  const wanted = new Set<MapToolGroup>(options.groups ?? MAP_TOOL_GROUPS);
  // A page with no clock has no clock group, rather than tools that always refuse.
  if (!world.hasClock) wanted.delete('clock');
  return tools.filter((tool) => {
    const group = info(tool.name as MapToolName).group;
    return group === 'view' || (group !== null && wanted.has(group));
  });
}

function requireClock(world: MapWorld): unknown {
  const clock = world.clock();
  if (!clock) throw new Error('this page has no clock');
  return clock;
}

/** The worked examples' own editing tools: edit_stop, a write, and reset_edits, their one consequential tool. */
export function createMapEditTools(world: MapWorld): MapToolDefinition[] {
  const inputs = mapInputs({ bodies: world.bodies, projections: world.projections });
  return [
    define(world, inputs, 'edit_stop', (args) =>
      world.editStop(args.walkthroughId, args.index, { title: args.title, text: args.text }),
    ),
    define(world, inputs, 'reset_edits', () => world.resetEdits()),
  ];
}
