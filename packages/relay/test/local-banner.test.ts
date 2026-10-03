// What local mode prints (ADR 0022): the `claude mcp add` line reads the token
// from its file as it runs, so the line itself never holds it. The POSIX line
// runs through sh -c against a stub `claude` from a path holding a space and
// quotes, and must hand over exactly `Authorization: Bearer <token>`; the
// PowerShell line is checked as text, and run too where pwsh exists.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeAddCommand,
  LOCAL_SERVER_NAME,
  localModeLines,
  quotePosix,
  quotePowerShell,
  shellFor,
} from '../src/local-banner.ts';
import { loadOwnerToken } from '../src/local-token.ts';
import { leakIn } from './helpers/secrecy.ts';

const POSIX = process.platform !== 'win32';
const MCP_URL = 'http://127.0.0.1:8787/mcp';
const HAS_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-banner-')));
  scratches.push(dir);
  return dir;
}

/** A `claude` that writes each argument it was given, NUL-terminated, to $TABDOCK_STUB_OUT. */
function stubClaude(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'claude');
  writeFileSync(
    stub,
    '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$TABDOCK_STUB_OUT"\n',
  );
  chmodSync(stub, 0o755);
  return bin;
}

function argumentsIn(file: string): string[] {
  const parts = readFileSync(file, 'utf8').split('\0');
  parts.pop();
  return parts;
}

const EXPECTED_HEAD = [
  'mcp',
  'add',
  '--transport',
  'http',
  '--scope',
  'user',
  LOCAL_SERVER_NAME,
  MCP_URL,
  '--header',
];

describe('the claude mcp add line', () => {
  it.skipIf(!POSIX)(
    'POSIX: run through sh -c from a path with a space and quotes, it passes exactly Authorization: Bearer <token>',
    () => {
      const dir = scratch();
      const home = join(dir, `owner's "tabdock" $HOME \`dir\``);
      const owner = loadOwnerToken({ TABDOCK_HOME: home });
      const line = claudeAddCommand('posix', MCP_URL, owner.path);
      expect(line).toBe(
        `claude mcp add --transport http --scope user tabdock-local ${MCP_URL} --header "Authorization: Bearer $(cat ${quotePosix(owner.path)})"`,
      );
      expect(leakIn(line, owner.token)).toBeNull();
      const bin = stubClaude(dir);
      const out = join(dir, 'arguments');
      const ran = spawnSync('sh', ['-c', line], {
        env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TABDOCK_STUB_OUT: out },
        encoding: 'utf8',
      });
      expect(ran.status, ran.stderr).toBe(0);
      const given = argumentsIn(out);
      expect(given.slice(0, -1)).toEqual(EXPECTED_HEAD);
      expect(given.length).toBe(EXPECTED_HEAD.length + 1);
      // Compared without printing it, should it ever differ.
      expect(given.at(-1) === `Authorization: Bearer ${owner.token}`).toBe(true);
    },
  );

  it('PowerShell: reads the first line with Get-Content -LiteralPath, the path single-quoted with quotes doubled', () => {
    const path = "C:\\Users\\O'Brien\u2019s PC\\AppData\\Local\\Tabdock\\owner-token";
    expect(claudeAddCommand('powershell', MCP_URL, path)).toBe(
      `claude mcp add --transport http --scope user tabdock-local ${MCP_URL} --header "Authorization: Bearer $(Get-Content -TotalCount 1 -LiteralPath 'C:\\Users\\O''Brien\u2019\u2019s PC\\AppData\\Local\\Tabdock\\owner-token')"`,
    );
    expect(quotePowerShell("a'b\u2018c\u201ad\u201be")).toBe(
      "'a''b\u2018\u2018c\u201a\u201ad\u201b\u201be'",
    );
  });

  it.skipIf(!POSIX || !HAS_PWSH)('PowerShell: run through pwsh, it passes the same header', () => {
    const dir = scratch();
    const owner = loadOwnerToken({ TABDOCK_HOME: join(dir, "owner's tabdock") });
    const bin = stubClaude(dir);
    const out = join(dir, 'arguments');
    const ran = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        claudeAddCommand('powershell', MCP_URL, owner.path),
      ],
      {
        env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TABDOCK_STUB_OUT: out },
        encoding: 'utf8',
      },
    );
    expect(ran.status, ran.stderr).toBe(0);
    const given = argumentsIn(out);
    expect(given.slice(0, -1)).toEqual(EXPECTED_HEAD);
    expect(given.at(-1) === `Authorization: Bearer ${owner.token}`).toBe(true);
  });

  it('quotes a URL only when it is more than a plain word, and picks the shell by platform', () => {
    expect(claudeAddCommand('posix', 'http://[::1]:8787/mcp', '/t')).toContain(
      "tabdock-local 'http://[::1]:8787/mcp' --header",
    );
    expect(claudeAddCommand('powershell', 'http://[::1]:8787/mcp', '/t')).toContain(
      "tabdock-local 'http://[::1]:8787/mcp' --header",
    );
    expect(quotePosix("it's")).toBe("'it'\\''s'");
    expect(shellFor('win32')).toBe('powershell');
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      expect(shellFor(platform)).toBe('posix');
    }
  });
});

describe('the local mode banner', () => {
  const banner = {
    mcpUrl: MCP_URL,
    pageUrl: 'ws://127.0.0.1:8787/page',
    tokenPath: '/home/me/.config/tabdock/owner-token',
    shell: 'posix' as const,
  };

  it('says it serves this computer only, where to connect, and where the token is', () => {
    const lines = localModeLines({ ...banner, created: true });
    const text = lines.join('\n');
    expect(text).toContain('this computer only');
    expect(text).toContain('trusts every account on it');
    expect(text).toContain(`MCP endpoint:  ${MCP_URL}`);
    expect(text).toContain('Page socket:   ws://127.0.0.1:8787/page');
    expect(text).toContain(`Owner token:   ${banner.tokenPath} (created just now)`);
    expect(text).toContain(`  ${claudeAddCommand('posix', MCP_URL, banner.tokenPath)}`);
    expect(text).toContain('claude mcp remove --scope user tabdock-local');
    expect(text).toContain('claude mcp list');
    // claude mcp get prints the header in full, so it is never suggested.
    expect(text).not.toContain('mcp get');
    expect(lines.at(-1)).toMatch(
      /Claude on the web, desktop or phone.*docs\/deploy\.md.*pnpm dev:public/,
    );
  });

  it('says when the token was kept from an earlier start, with no replacement step', () => {
    const text = localModeLines({ ...banner, created: false }).join('\n');
    expect(text).toContain(`${banner.tokenPath} (kept from an earlier start)`);
    expect(text).not.toContain('claude mcp remove');
  });

  it('prints the PowerShell form on Windows', () => {
    const path = 'C:\\Users\\me\\AppData\\Local\\Tabdock\\owner-token';
    const text = localModeLines({
      ...banner,
      tokenPath: path,
      shell: 'powershell',
      created: false,
    }).join('\n');
    expect(text).toContain(`Get-Content -TotalCount 1 -LiteralPath '${path}'`);
  });
});
