// The classroom pnpm demo:m6 runs in, entirely on this machine: the relay in
// public URL mode on loopback against the relay tests' stand-in identity
// provider, with invites, agent tokens and the restart snapshot on, its
// members in a file it reads again when the file changes (ADR 0043) and a
// hash-chained audit directory (ADR 0019); the canvas map page served from
// memory (ADR 0038); and MCP clients that reach the relay through the
// stand-in tunnel with tokens the provider signed. Each token and the
// relay's own client secret are handed to the narrator as secrets, and every
// line the relay logs is kept so the run can show none of them holds one.
//
// One setting differs from a deployment's: the pairings one page may take a
// minute (30, S14) and the sign-ins the relay takes a minute (60), raised as
// tests/e2e/src/room-harness.ts raises them, so a class of forty joins in
// seconds and what turns the forty-first away is the seats alone. A real
// class arrives at 30 a minute (docs/notes/m6/room-measure.md).

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type MapPageServer, startMapPageServer } from '@tabdock/map-page/server';
import {
  createOAuthAuth,
  createRelay,
  EMAIL_CLAIM,
  EMAIL_VERIFIED_CLAIM,
  type Relay,
} from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import type { Narrator } from './narrator.ts';

export { PUBLIC_MCP_URL, PUBLIC_ORIGIN };

export interface Member {
  sub: string;
  userId: string;
  displayName: string;
}

/** The teacher, whose Claude drives the projected map. */
export const ALICE: Member = { sub: 'sub-alice-teacher', userId: 'alice', displayName: 'Alice' };
/** A colleague the members file adds and then removes. */
export const BOB: Member = { sub: 'sub-bob-colleague', userId: 'bob', displayName: 'Bob' };

export interface Classroom {
  /** The relay running now; a restart replaces it on the same port and audit directory. */
  readonly relay: Relay;
  readonly provider: TestProvider;
  readonly map: MapPageServer;
  readonly auditDir: string;
  /** Every line every relay of this run has logged. */
  readonly logLines: readonly string[];
  /** Replaces the members file by renaming a whole new file over it, as guide page 14 says. */
  saveMembers(members: readonly Member[]): void;
  /** A graceful stop, then a start on the same port and audit directory. */
  restart(): Promise<void>;
  /**
   * Claude on an account: an SDK client 2.3.1 through the stand-in tunnel
   * with a token the provider signed for the relay, and a verified email
   * when given one, as an invitee's provider sends it (ADR 0020).
   */
  claude(name: string, sub: string, email?: string): Promise<Client>;
  close(): Promise<void>;
}

export async function startClassroom(narrator: Narrator, scratch: string): Promise<Classroom> {
  // The file and every directory above it writable by this account alone, as the relay requires.
  const membersDir = join(scratch, 'members');
  mkdirSync(membersDir, { mode: 0o700 });
  const membersFile = join(membersDir, 'members.txt');
  const saveMembers = (members: readonly Member[]): void => {
    const next = `${membersFile}.new`;
    const lines = members.map((member) => `${member.sub}=${member.userId}:${member.displayName}`);
    writeFileSync(next, `${lines.join('\n')}\n`, { mode: 0o600 });
    renameSync(next, membersFile);
  };
  saveMembers([ALICE]);
  const auditDir = join(scratch, 'audit');
  const logLines: string[] = [];
  const clients: Client[] = [];

  const provider = await startProvider();
  narrator.remember(PAIR_CLIENT.clientSecret);
  // Tokens the provider issues at a sign-in at /i, read afresh at each line.
  narrator.rememberFrom(() => provider.issuedTokens);
  const map = await startMapPageServer();

  const start = (port: number): Promise<Relay> =>
    createRelay({
      // The file's list wins over this one, read at start and again whenever it changes.
      auth: createOAuthAuth({ issuer: provider.issuer, resource: PUBLIC_MCP_URL, users: [ALICE] }),
      membersFile,
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [new URL(map.url).origin],
      invites: true,
      agentTokens: true,
      restartSnapshot: true,
      audit: { dir: auditDir },
      rateLimits: { pairAttemptsPerPage: 500, pairSignIns: 500 },
      port,
      logSink: (line) => {
        logLines.push(line);
      },
    });

  let relay: Relay;
  try {
    relay = await start(0);
  } catch (error) {
    await map.close();
    await provider.stop();
    throw error;
  }

  return {
    get relay() {
      return relay;
    },
    provider,
    map,
    auditDir,
    logLines,
    saveMembers,
    async restart() {
      const port = Number(new URL(relay.url).port);
      await relay.close();
      relay = await start(port);
    },
    async claude(name, sub, email) {
      const token = await provider.token({
        sub,
        aud: PUBLIC_MCP_URL,
        ...(email === undefined ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
      });
      narrator.remember(token);
      const client = new Client({ name, version: '1.0.0' });
      // Bound to the relay's address, which a restart on the same port keeps.
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
          authProvider: { token: () => Promise.resolve(token) },
          fetch: tunnelFetch(relay.url),
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await relay.close().catch(() => undefined);
      await map.close();
      await provider.stop();
    },
  };
}
