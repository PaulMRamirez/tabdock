// The page's state as its link publishes it (ADR 0040): the view, stop and
// observation, sent on each discrete change and never twice alike, so a
// write that changes nothing spends none of the relay's state budget. A
// drag's view is drawn but never written to the world until it lands, so it
// is never published per frame either.

import type { MapPageState, MapWorld } from '@tabdock/sim-page/map';

/** A function that sends the world's state when it differs from the last it sent. */
export function statePublisher(world: MapWorld, send: (state: MapPageState) => void): () => void {
  let last: string | null = null;
  return () => {
    const state = world.state();
    const text = JSON.stringify(state);
    if (text === last) return;
    last = text;
    send(state);
  };
}
