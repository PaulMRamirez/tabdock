// pnpm spike:soak: the headless half of the M3 tab-survival spike (A3.3). Runs
// the demo page with the real adapter in Chromium against a relay in this
// process (throwaway dev tokens, loopback only), attaches one MCP client as a
// driver, then freezes the page through the DevTools protocol and thaws it, over
// and over, for the length asked (60 minutes by default). After each thaw it
// checks that the adapter reconnected and resumed: the same page id, the
// attachment intact and a get_view call that works. Link drops and resumes are
// printed with timestamps as they happen, and a markdown table for
// docs/notes/spike.md comes at the end.
//
// It tests the adapter's recovery from a freeze, not whether Chrome freezes a
// real background tab: Energy Saver (try the demo with ?busy), Memory Saver and
// laptop sleep are the owner's manual runs. No token or pairing code is printed.

import { parseArgs } from 'node:util';
import { cycleOk, runSoak, type SoakOptions, soakReport } from '../../tests/e2e/src/spike/soak.ts';

const USAGE = `pnpm spike:soak [options]

  --minutes <n>          how long to soak (default 60)
  --freeze-seconds <n>   how long each freeze lasts (default 300; the relay drops a silent page after 30)
  --active-seconds <n>   how long the page runs, still hidden, between freezes (default 30)
  --quick                a few minutes: --minutes 3 --freeze-seconds 40 --active-seconds 10
  --busy <percent>       open the demo with ?busy=<percent>, as for the Energy Saver run
  --headed               show the browser
`;

function fail(message: string): never {
  process.stderr.write(`spike:soak: ${message}\n`);
  process.exit(1);
}

function readArgs() {
  const given = process.argv.slice(2);
  try {
    return parseArgs({
      args: given[0] === '--' ? given.slice(1) : given,
      options: {
        minutes: { type: 'string' },
        'freeze-seconds': { type: 'string' },
        'active-seconds': { type: 'string' },
        quick: { type: 'boolean', default: false },
        busy: { type: 'string' },
        headed: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

function number(name: string, text: string | undefined, fallback: number, max: number): number {
  if (text === undefined) return fallback;
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > max) {
    fail(`--${name} must be a whole number from 1 to ${String(max)}`);
  }
  return Number(text);
}

const values = readArgs();
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const quick = values.quick;
const minutes = number('minutes', values.minutes, quick ? 3 : 60, 24 * 60);
const freezeSeconds = number(
  'freeze-seconds',
  values['freeze-seconds'],
  quick ? 40 : 300,
  24 * 3600,
);
const activeSeconds = number('active-seconds', values['active-seconds'], quick ? 10 : 30, 3600);
const busy = values.busy === undefined ? undefined : number('busy', values.busy, 50, 100);

const options: SoakOptions = {
  durationMs: minutes * 60_000,
  freezeMs: freezeSeconds * 1000,
  activeMs: activeSeconds * 1000,
  headless: !values.headed,
  ...(busy === undefined ? {} : { busy }),
  say: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

process.stderr.write(
  `Soaking for ${String(minutes)} min: ${String(freezeSeconds)} s freezes, ${String(activeSeconds)} s awake between them.\n`,
);
try {
  const report = await runSoak(options);
  process.stdout.write(`\n${soakReport(report, options)}`);
  if (!report.ok) {
    const failed = report.cycles.find((cycle) => !cycleOk(cycle));
    fail(`cycle ${String(failed?.cycle ?? 0)} did not come back whole`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
