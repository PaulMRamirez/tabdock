// M3 spike (A3.3): `?busy` makes the board use CPU on purpose, for the owner's
// manual Energy Saver run. Chrome's Energy Saver freezes only background tabs
// that use a lot of CPU (docs/notes/m3/tunnel-qr-spike.md), and the demo board
// on its own uses almost none, so without this the run would show nothing.
// `?busy` spins half of every 100 ms; `?busy=<1-100>` sets the share.
// The spinning runs in a dedicated worker by default, which keeps the page's
// own thread, and so the adapter, responsive; `&busyIn=main` spins in a timer
// on the page itself instead, which Chrome throttles once the tab has been
// hidden for five minutes.

export interface BusySetting {
  /** Percent of each 100 ms slice spent spinning, 1 to 100. */
  share: number;
  where: 'worker' | 'main';
}

const SLICE_MS = 100;

/** Reads ?busy and ?busyIn; null without ?busy, or with a value that is not 1 to 100. */
export function busyFromQuery(params: URLSearchParams): BusySetting | null {
  const raw = params.get('busy');
  if (raw === null) return null;
  const share = raw === '' ? 50 : /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(share) || share < 1 || share > 100) return null;
  return { share, where: params.get('busyIn') === 'main' ? 'main' : 'worker' };
}

/** Spins for `share` percent of every slice. The worker's copy is this same function, as text. */
function spin(share: number, slice: number): void {
  const busyMs = (slice * share) / 100;
  const tick = (): void => {
    const start = performance.now();
    while (performance.now() - start < busyMs) {
      // Spinning is the point.
    }
    setTimeout(tick, Math.max(0, slice - busyMs));
  };
  tick();
}

/** Starts spinning and returns a line for the page to show. */
export function startBusy(setting: BusySetting): string {
  if (setting.where === 'main') {
    spin(setting.share, SLICE_MS);
  } else {
    const source = `(${spin.toString()})(${String(setting.share)}, ${String(SLICE_MS)});`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    new Worker(url);
  }
  const where = setting.where === 'main' ? 'a timer on the page' : 'a worker';
  return `CPU-busy mode (?busy): spinning ${String(setting.share)}% of the time in ${where}, for the Energy Saver soak`;
}
