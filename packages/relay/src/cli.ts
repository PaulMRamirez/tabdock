#!/usr/bin/env node
// The relay as a command (ADR 0028): `tabdock-relay`, the one bin the
// published package has, so `npx @tabdock/relay` runs it, and what `pnpm
// relay` runs in a checkout through main.ts.
//
//   tabdock-relay                start the relay from the environment
//   tabdock-relay --new-token    replace local mode's owner token, then start
//   tabdock-relay audit [...]    read the audit log, as pnpm audit:log does
//   tabdock-relay --version | --help
//
// Any other argument is refused with the usage, so a mistyped flag never
// starts a relay; a refusal never repeats an argument that is not a flag name,
// since a token pasted in the wrong place is still a token. The published
// command reads no .env file: settings come from the environment alone, as on
// a host, so running it inside someone's project never picks up that
// project's file. A checkout keeps reading its root .env (ADR 0022).
//
// The relay prints where to connect and nothing secret: in local mode the
// owner token's path and a command that never holds the token. JSON log lines
// go to stderr.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { runAuditCli } from './audit-cli.ts';
import type { AuthPlugin } from './auth.ts';
import { type EnvConfig, loadConfigFromEnv } from './config.ts';
import { localModeLines, shellFor } from './local-banner.ts';
import { PACKAGED } from './packaged.ts';
import { createRelay, type Relay } from './relay.ts';
import { attachSpikeConsole, SPIKE_CONSOLE_HELP } from './spike.ts';

/** The published command's name. */
export const RELAY_COMMAND = 'tabdock-relay';

export type Command =
  | { kind: 'start'; newToken: boolean }
  | { kind: 'audit'; args: string[] }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'refused'; reason: string };

/** How each form is spelled where it runs: the bin in the package, pnpm scripts in a checkout. */
function names(packaged: boolean): { relay: string; audit: string } {
  return packaged
    ? { relay: RELAY_COMMAND, audit: `${RELAY_COMMAND} audit` }
    : { relay: 'pnpm relay', audit: 'pnpm audit:log' };
}

/** The command's usage, naming the command it runs under. */
export function relayUsage(packaged: boolean): string {
  const { relay, audit } = names(packaged);
  const settings = packaged
    ? 'Settings come from the environment alone; no .env file is read.'
    : "Settings come from the environment and the checkout's .env, if any.";
  return `Usage: ${relay} [--new-token]
       ${relay} audit [options]
       ${relay} --version | --help

Starts the Tabdock relay. With no settings it runs local mode: it listens on
127.0.0.1:8787 for this computer only, keeps an owner token in a private file
(TABDOCK_HOME, or the per-user configuration directory) and prints how to add
it to Claude Code.
${settings}

  --new-token   draw a new owner token in place of the old one, then start;
                local mode only
  audit         read the relay's audit log; for its options:
                ${audit} --help
  --version     print the version
  --help        this text`;
}

const FLAGS: Readonly<Record<string, Command>> = {
  '--new-token': { kind: 'start', newToken: true },
  '--version': { kind: 'version' },
  '-v': { kind: 'version' },
  '--help': { kind: 'help' },
  '-h': { kind: 'help' },
};

/** An argument as a refusal names it: a flag by its name, anything else only by its place. */
function named(arg: string, position: number): string {
  return /^--?[a-z][a-z-]{0,31}$/.test(arg) ? `the option ${arg}` : `argument ${String(position)}`;
}

/** What the arguments ask for; a refusal says why without repeating anything but a flag's name. */
export function parseCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'start', newToken: false };
  if (first === 'audit') return { kind: 'audit', args: rest };
  const flag = Object.hasOwn(FLAGS, first) ? FLAGS[first] : undefined;
  if (flag === undefined) {
    return { kind: 'refused', reason: `${named(first, 1)} is not one this command takes` };
  }
  const [second] = rest;
  if (second !== undefined) {
    return {
      kind: 'refused',
      reason: `${first} takes nothing after it, and ${named(second, 2)} is not one this command takes`,
    };
  }
  return flag;
}

const PackageJsonSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
});

/**
 * The version in the package.json beside this code: packages/relay's in a
 * checkout, the installed package's from the bundle in dist/. RELAY_VERSION,
 * which the server info and relay_start carry, is held equal to it by
 * test/version.test.ts.
 */
export function packageVersion(base: string = import.meta.url): string {
  const text = readFileSync(new URL('../package.json', base), 'utf8');
  return PackageJsonSchema.parse(JSON.parse(text)).version;
}

/** The checkout's root .env that a checkout reads, or null for the package, which reads none. */
export function checkoutEnvFile(packaged: boolean): string | null {
  return packaged ? null : resolve(import.meta.dirname, '../../../.env');
}

/**
 * Loads the checkout's .env into process.env, where variables already set
 * win; the package never does (ADR 0028).
 */
export function loadCheckoutEnv(packaged: boolean): void {
  const file = checkoutEnvFile(packaged);
  if (file !== null && existsSync(file)) process.loadEnvFile(file);
}

export interface CommandContext {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  out(line: string): void;
  err(line: string): void;
}

/**
 * The plugin with `commit` run first in its start, which createRelay calls
 * only after it holds the audit directory's lock: so `--new-token` beside a
 * running relay that shares the directory refuses on the lock before the
 * token changes, and a start that fails later keeps the new token, which no
 * client has yet.
 */
function committingFirst(auth: AuthPlugin, commit: () => void): AuthPlugin {
  return {
    ...auth,
    async start(context) {
      commit();
      await auth.start?.(context);
    },
  };
}

export interface StartedRelay {
  relay: Relay;
  options: EnvConfig;
  /** The banner, without the spike console's help. */
  lines: string[];
}

/**
 * Starts the relay from `context.env` and returns it with its banner. With
 * `newToken`, local mode's start draws a new token without reading the old
 * file and renames it into place once the audit directory is locked; outside
 * local mode the flag is refused by name before anything starts.
 */
export async function startRelay(
  context: CommandContext,
  { newToken }: { newToken: boolean },
): Promise<StartedRelay> {
  const pending: { commit?: () => void } = {};
  const options = loadConfigFromEnv(
    context.env,
    newToken
      ? {
          replaceToken: (commit) => {
            pending.commit = commit;
          },
        }
      : {},
  );
  if (newToken && (options.localMode === undefined || pending.commit === undefined)) {
    throw new Error(
      "--new-token replaces local mode's owner token, and this relay is not in local mode: an auth setting such as TABDOCK_DEV_TOKENS or TABDOCK_PUBLIC_URL is set, or TABDOCK_ENV is production (ADR 0028)",
    );
  }
  const auth =
    pending.commit === undefined ? options.auth : committingFirst(options.auth, pending.commit);
  const relay = await createRelay({ ...options, auth });
  const local = options.localMode;
  const lines =
    relay.publicMcpUrl !== null
      ? [
          `Tabdock relay on ${relay.url}, public URL ${relay.publicUrl ?? ''}`,
          `  Connector URL (OAuth sign-in through TABDOCK_OAUTH_ISSUER): ${relay.publicMcpUrl}`,
          `  QR pairing page, signing phones in with TABDOCK_PAIR_CLIENT_ID: ${relay.publicUrl ?? ''}/pair`,
          // Hosted mode takes pages through the edge (ADR 0018); a tunnelled relay only from this machine.
          options.clientAddressHeader === undefined
            ? `  Page socket for the adapter, on this machine only: ${relay.pageUrl}`
            : `  Page socket for the adapter, through the host edge: ${(relay.publicUrl ?? '').replace(/^https:/, 'wss:')}/page`,
          ...((context.env.TABDOCK_DEV_TOKENS?.trim() ?? '') === ''
            ? []
            : [
                '  TABDOCK_DEV_TOKENS is ignored: a relay with a public URL accepts only OAuth tokens',
              ]),
        ]
      : local !== undefined
        ? [
            `Tabdock relay on ${relay.url}`,
            ...localModeLines({
              mcpUrl: relay.mcpUrl,
              pageUrl: relay.pageUrl,
              tokenPath: local.tokenPath,
              created: local.created,
              shell: shellFor(context.platform),
              replaced: newToken,
              packaged: context.packaged,
            }),
          ]
        : [
            `Tabdock relay on ${relay.url}`,
            `  MCP endpoint (bearer token from TABDOCK_DEV_TOKENS): ${relay.mcpUrl}`,
            `  Page socket for the adapter: ${relay.pageUrl}`,
          ];
  return { relay, options, lines };
}

/**
 * Runs the command; resolves with an exit code, or null once a relay is
 * serving, which a signal then closes. Errors from the configuration and the
 * owner token name variables and paths, never their secrets, so they are
 * printed as they are.
 */
export async function runCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<number | null> {
  const command = parseCommand(argv);
  const { relay: relayName, audit: auditName } = names(context.packaged);
  switch (command.kind) {
    case 'refused':
      context.err(`${relayName}: ${command.reason}`);
      context.err(relayUsage(context.packaged));
      return 2;
    case 'help':
      context.out(relayUsage(context.packaged));
      return 0;
    case 'version':
      context.out(packageVersion());
      return 0;
    case 'audit':
      return runAuditCli(command.args, context.env, context, Date.now(), auditName);
    case 'start':
      break;
  }
  try {
    const { relay, lines } = await startRelay(context, { newToken: command.newToken });
    // Before the banner, so whoever reads it (a test, a supervisor) knows a
    // SIGTERM from then on closes the relay and its audit log cleanly.
    const stop = (): void => {
      relay.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    context.out(lines.join('\n'));
    // The spike's marker is controlled from this terminal and nothing else (spike.ts).
    if (relay.spike) {
      context.out(SPIKE_CONSOLE_HELP);
      attachSpikeConsole(relay.spike, process.stdin, (line) => {
        context.out(line);
      });
    }
    return null;
  } catch (error) {
    context.err(`tabdock relay: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** The process's own context: its environment, platform and terminal. */
export function processContext(packaged: boolean): CommandContext {
  return {
    packaged,
    env: process.env,
    platform: process.platform,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// Run as the bin, or as `node src/cli.ts` in a checkout. main.ts imports this
// module for `pnpm relay`, and is then the one that runs it.
if (import.meta.main) {
  loadCheckoutEnv(PACKAGED);
  const code = await runCommand(process.argv.slice(2), processContext(PACKAGED));
  if (code !== null) process.exitCode = code;
}
