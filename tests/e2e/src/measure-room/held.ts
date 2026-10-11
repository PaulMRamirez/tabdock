// One answer its client reads slowly or not at all (ADR 0044, A6.22): what
// the stall rule and TABDOCK_MAX_RESPONSE_BYTES exist for. The client pauses
// the response, so while it holds still its socket is not read either, and a
// relay that cuts the answer goes unseen until the client reads again. So an
// answer is settled at the end of its phase by draining what is left: one
// that then ends whole was never cut, whatever the relay had sent of it, and
// one whose connection ends first was cut. Nothing the answer holds is kept
// beyond its first KiB, which is read only for a refusal's code.

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';

/**
 * pending until the relay answers, held while the client is reading slowly
 * or not at all; settled as whole (it ended complete), cut (its connection
 * ended first), the code a refusal began with, or open when it neither
 * ended nor broke within the settling time.
 */
export type HeldOutcome = 'pending' | 'held' | 'whole' | 'cut' | 'open' | (string & {});

export interface HeldAnswer {
  readonly outcome: HeldOutcome;
  /** Resolves once the outcome is final, by the client's own reading or by settle. */
  readonly done: Promise<HeldOutcome>;
  /** Reads what is left as fast as it comes, up to `timeoutMs`, and gives the final outcome. */
  settle(timeoutMs: number): Promise<HeldOutcome>;
}

export interface HoldOptions {
  /** The relay's /mcp, on loopback. */
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** stall reads nothing after the first KiB; trickle takes at most `takeBytes` every `everyMs`. */
  mode: 'stall' | 'trickle';
  takeBytes?: number;
  everyMs?: number;
  /** Each answer's status, as the edge counts statuses. */
  onStatus?: (status: number) => void;
}

export function holdAnswer(options: HoldOptions): HeldAnswer {
  let outcome: HeldOutcome = 'pending';
  let draining = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let response: IncomingMessage | null = null;
  let finish: (final: HeldOutcome) => void = () => undefined;
  const done = new Promise<HeldOutcome>((resolve) => {
    finish = (final) => {
      if (timer !== undefined) clearInterval(timer);
      // The first word stands: a refusal, or a cut seen before a late 'end'.
      if (outcome === 'pending' || outcome === 'held') outcome = final;
      resolve(outcome);
    };
  });
  const settled = (): boolean => outcome !== 'pending' && outcome !== 'held';

  const req: ClientRequest = httpRequest(
    options.url,
    { method: 'POST', agent: false, headers: options.headers },
    (res) => {
      response = res;
      options.onStatus?.(res.statusCode ?? 0);
      res.pause();
      res.once('readable', () => {
        const first = (res.read(1024) as Buffer | null) ?? (res.read() as Buffer | null);
        const text = first?.toString('utf8') ?? '';
        if (/"isError":true/.test(text) || (res.statusCode ?? 0) !== 200) {
          outcome = /"text":"([a-z_]+): /.exec(text)?.[1] ?? `http ${String(res.statusCode ?? 0)}`;
          res.resume();
          finish(outcome);
          return;
        }
        outcome = 'held';
        // Settled before its first bytes came: drain from here.
        if (draining) {
          res.resume();
          return;
        }
        if (options.mode === 'trickle') {
          const take = options.takeBytes ?? 65_536;
          // read(n) takes nothing while fewer than n bytes wait, so it asks for what is there.
          timer = setInterval(() => {
            res.read(Math.min(take, res.readableLength));
          }, options.everyMs ?? 25_000);
        }
      });
      res.on('end', () => {
        finish(res.complete ? 'whole' : 'cut');
      });
      res.on('close', () => {
        finish(res.complete ? 'whole' : 'cut');
      });
      res.on('error', () => undefined);
    },
  );
  req.on('error', () => {
    finish('cut');
  });
  req.end(options.body);

  return {
    get outcome() {
      return outcome;
    },
    done,
    async settle(timeoutMs) {
      if (settled()) return outcome;
      if (timer !== undefined) clearInterval(timer);
      // Drained, an answer the relay still holds arrives whole; a cut one ends early.
      // Before its first bytes, the 'readable' that reads them drains the rest.
      draining = true;
      if (response !== null && response.listenerCount('readable') === 0) response.resume();
      const late = setTimeout(() => {
        finish('open');
        req.destroy();
      }, timeoutMs);
      const final = await done;
      clearTimeout(late);
      return final;
    },
  };
}
