// pnpm spike:latency: the round-trip half of the M3 spike (A3.3). Connects to
// a relay's MCP URL, pairs with a page (or reuses an attachment), makes 5
// warm-up and then 50 sequential call_page_tool get_view calls, and prints p50,
// p95, min and max by nearest rank as a markdown table for docs/notes/spike.md.
// With the relay's TABDOCK_SPIKE=1 the table also splits each round trip into
// the relay's part (the page included) and the rest (tunnel, network, client).
//
// Local relay (http on loopback): a dev token from TABDOCK_DEV_TOKENS in .env
// (the --user entry, else the first), or TABDOCK_SPIKE_TOKEN.
// Public URL (https): the SDK's OAuth sign-in, with a sign-in URL printed for
// you to open in a browser on this machine and a loopback redirect.
// Tokens and pairing codes are never printed.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  choosePage,
  connectWithBearer,
  connectWithOAuth,
  latencyReport,
  measureCalls,
} from '../../tests/e2e/src/spike/latency.ts';
import { parseDevTokens } from '../../packages/relay/src/index.ts';

const USAGE = `pnpm spike:latency [options]

  --url <url>           MCP URL to time (default http://127.0.0.1:<TABDOCK_PORT or 8787>/mcp)
  --public              time <TABDOCK_PUBLIC_URL>/mcp instead, signing in through OAuth
  --code <code>         pair with the code the page shows (approve it on the page)
  --page <id>           reuse an attachment to this page (default: your one awake page)
  --user <id>           dev-token user for a local relay (default: the first in TABDOCK_DEV_TOKENS)
  --tool <name>         page tool to call (default get_view)
  --args <json>         its arguments as a JSON object (default {})
  --warmup <n>          warm-up calls, not counted (default 5)
  --calls <n>           measured calls (default 50)
  --modern              speak MCP 2026-07-28 rather than the SDK's default 2025 revision
  --callback-port <n>   loopback port for the OAuth redirect (default: any free port)
  --client-id <id>      a client registered with the provider (default: TABDOCK_SPIKE_CLIENT_ID,
                        else dynamic registration)
`;

function fail(message: string): never {
  process.stderr.write(`spike:latency: ${message}\n`);
  process.exit(1);
}

function count(name: string, text: string | undefined, fallback: number, min: number): number {
  if (text === undefined) return fallback;
  if (!/^\d{1,6}$/.test(text) || Number(text) < min) {
    fail(`--${name} must be a whole number of at least ${String(min)}`);
  }
  return Number(text);
}

const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function readArgs() {
  // pnpm may pass on a leading `--` meant for itself.
  const given = process.argv.slice(2);
  try {
    return parseArgs({
      args: given[0] === '--' ? given.slice(1) : given,
      options: {
        url: { type: 'string' },
        public: { type: 'boolean', default: false },
        code: { type: 'string' },
        page: { type: 'string' },
        user: { type: 'string' },
        tool: { type: 'string', default: 'get_view' },
        args: { type: 'string', default: '{}' },
        warmup: { type: 'string' },
        calls: { type: 'string' },
        modern: { type: 'boolean', default: false },
        'callback-port': { type: 'string' },
        'client-id': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}
const values = readArgs();
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (values.code !== undefined && values.page !== undefined) fail('give --code or --page, not both');

let url: URL;
if (values.url !== undefined) {
  url = URL.parse(values.url) ?? fail('--url is not a URL');
} else if (values.public) {
  const origin = process.env.TABDOCK_PUBLIC_URL?.trim() ?? '';
  if (origin === '') fail('--public needs TABDOCK_PUBLIC_URL in .env');
  url = new URL('/mcp', origin);
} else {
  const port = process.env.TABDOCK_PORT?.trim() || '8787';
  url = new URL(`http://127.0.0.1:${port}/mcp`);
}

let args: Record<string, unknown>;
try {
  const value: unknown = JSON.parse(values.args);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  args = value as Record<string, unknown>;
} catch {
  fail('--args must be a JSON object');
}
const warmup = count('warmup', values.warmup, 5, 0);
const calls = count('calls', values.calls, 50, 1);
const callbackPort = count('callback-port', values['callback-port'], 0, 0);
const era = values.modern ? '2026-07-28' : '2025 (the SDK default)';
const envClientId = process.env.TABDOCK_SPIKE_CLIENT_ID?.trim() ?? '';
const clientId = values['client-id'] ?? (envClientId === '' ? undefined : envClientId);
// A client id given in advance belongs to the provider in .env, and goes to no other.
const envIssuer = process.env.TABDOCK_OAUTH_ISSUER?.trim() ?? '';
const clientIssuer = clientId === undefined || envIssuer === '' ? undefined : envIssuer;
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];

/** A dev token only ever goes to a relay on this machine, never across a network in the clear. */
function bearerToken(): string {
  if (url.protocol !== 'http:' || !loopbackHosts.includes(url.hostname)) {
    fail(
      'a bearer token is sent only to an http relay on loopback; an https URL signs in through OAuth',
    );
  }
  const explicit = process.env.TABDOCK_SPIKE_TOKEN?.trim() ?? '';
  if (explicit !== '') return explicit;
  const listed = process.env.TABDOCK_DEV_TOKENS?.trim() ?? '';
  if (listed === '')
    fail('set TABDOCK_DEV_TOKENS in .env (or TABDOCK_SPIKE_TOKEN) for a local relay');
  const users = parseDevTokens(listed);
  const user = values.user === undefined ? users[0] : users.find((u) => u.userId === values.user);
  if (!user) fail(`TABDOCK_DEV_TOKENS has no user ${values.user ?? ''}`);
  return user.token;
}

try {
  const client =
    url.protocol === 'https:'
      ? await connectWithOAuth(url.href, {
          modern: values.modern,
          callbackPort,
          ...(clientId === undefined ? {} : { clientId }),
          ...(clientIssuer === undefined ? {} : { clientIssuer }),
          showSignIn: (signIn) => {
            process.stderr.write(
              `\nSign in to run the latency spike: open this URL in a browser on this machine.\n\n  ${signIn.href}\n\nWaiting for the browser to come back...\n`,
            );
          },
        })
      : await connectWithBearer(url.href, bearerToken(), { modern: values.modern });
  try {
    if (values.code !== undefined) {
      process.stderr.write('Pairing: approve the request on the page within 50 seconds.\n');
    }
    const page = await choosePage(client, {
      ...(values.code === undefined ? {} : { code: values.code }),
      ...(values.page === undefined ? {} : { page: values.page }),
    });
    process.stderr.write(
      `Timing ${String(warmup)} warm-up and ${String(calls)} measured ${values.tool} calls on ${page}...\n`,
    );
    const samples = await measureCalls(client, {
      page,
      tool: values.tool,
      args,
      warmup,
      calls,
      onCall: (index, total, sample) => {
        const phase = index < warmup ? 'warm-up' : 'call';
        const relay = sample.timing ? `, relay ${sample.timing.relayMs.toFixed(1)} ms` : '';
        process.stderr.write(
          `  ${phase} ${String(index + 1)}/${String(total)}: ${sample.roundTripMs.toFixed(1)} ms${relay}${sample.ok ? '' : ' (failed)'}\n`,
        );
      },
    });
    process.stdout.write(
      `\n${latencyReport(samples, { url: url.href, tool: values.tool, warmup, era })}`,
    );
  } finally {
    await client.close();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
