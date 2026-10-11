// startMapSimPage: the sim page running the map profile's worked example,
// for relay tests through the real adapter core. The world is made once,
// outside the page's boot, so it survives reload() as a page's server-side
// state would, while the tools are registered afresh on every boot.

import {
  createMapEditTools,
  createMapTools,
  createMapWorld,
  MAP_PAGE_POLICY,
  type MapCapture,
  type MapToolGroup,
  type MapWorld,
} from './map/index.ts';
import { type SimPage, type SimPageOptions, startSimPage } from './sim-page.ts';

export interface MapSimPageOptions extends Omit<SimPageOptions, 'tools'> {
  /** The Moon fixture's world unless set. */
  world?: MapWorld;
  /** Lets capture_view return an image; the policy then names it an image tool (ADR 0039). */
  capture?: MapCapture;
  /** edit_stop and reset_edits beside the profile; true unless set. */
  editTools?: boolean;
  /** The optional groups to register; every one the world serves unless set. */
  groups?: readonly MapToolGroup[];
}

export interface MapSimPage extends SimPage {
  readonly world: MapWorld;
}

/**
 * The page's policy is MAP_PAGE_POLICY unless set, with capture_view among
 * its image tools when a capture function is given. A policy given here is
 * taken whole, so a test can pass the empty list ADR 0034 warns about.
 */
export async function startMapSimPage(options: MapSimPageOptions): Promise<MapSimPage> {
  const { world: given, capture, editTools = true, groups, policy, ...rest } = options;
  const world = given ?? createMapWorld();
  const sim = await startSimPage({
    ...rest,
    policy:
      policy ??
      (capture
        ? {
            ...MAP_PAGE_POLICY,
            consequentialTools: [...MAP_PAGE_POLICY.consequentialTools],
            imageTools: ['capture_view'],
          }
        : { consequentialTools: [...MAP_PAGE_POLICY.consequentialTools] }),
    tools: () => [
      ...createMapTools(world, { capture, groups }),
      ...(editTools ? createMapEditTools(world) : []),
    ],
  });
  // M6 seam: not built. W2-E publishes world.state() through the sim page's handle on each
  // change, skipping identical states (ADR 0040), for map-profile.test.ts test 7.
  return Object.assign(sim, { world });
}
