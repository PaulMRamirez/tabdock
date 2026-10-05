// What local mode prints (ADRs 0022 and 0028). On POSIX shells the banner's
// `claude mcp add-json` line hands Claude Code a headersHelper, the script
// beside the token, so neither the line nor Claude Code's settings hold the
// token: a quoting matrix of token directories runs each printed line through
// sh -c against a stub `claude`, reads back the JSON it was given, and runs
// that headersHelper through a shell as Claude Code does, which must print
// exactly the header. A path double quotes cannot carry falls back to ADR
// 0022's `claude mcp add --header` line, which reads the token from its file
// as it runs and must hand over exactly `Authorization: Bearer <token>`; the
// PowerShell line is checked as text, and run too where pwsh exists.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
  claudeAddJsonCommand,
  claudeCommandFor,
  helperCommand,
  LOCAL_SERVER_NAME,
  localModeLines,
  quotePosix,
  quotePowerShell,
  shellFor,
} from '../src/local-banner.ts';
import { headersHelperPath, loadOwnerToken } from '../src/local-token.ts';
import { DEPLOY_GUIDE_URL } from '../src/packaged.ts';
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

  it('says it serves this computer only, where to connect, where the token and its helper are', () => {
    const lines = localModeLines({ ...banner, created: true });
    const text = lines.join('\n');
    expect(text).toContain('this computer only');
    expect(text).toContain('trusts every account on it');
    expect(text).toContain(`MCP endpoint:  ${MCP_URL}`);
    expect(text).toContain('Page socket:   ws://127.0.0.1:8787/page');
    expect(text).toContain(`Owner token:   ${banner.tokenPath} (created just now)`);
    expect(text).toContain(
      'Header helper: /home/me/.config/tabdock/claude-headers (holds no token)',
    );
    expect(lines).toContain(
      `  claude mcp add-json --scope user tabdock-local '{"type":"http","url":"${MCP_URL}","headersHelper":"/home/me/.config/tabdock/claude-headers"}'`,
    );
    expect(text).not.toContain('--header');
    expect(text).toMatch(
      /If Claude Code says tabdock-local already exists, .*claude mcp remove --scope user tabdock-local/,
    );
    expect(text).toContain('claude mcp list');
    // claude mcp get prints a stored header in full, so it is never suggested.
    expect(text).not.toContain('mcp get');
    expect(text).not.toContain('The token is new');
    expect(lines.at(-1)).toMatch(
      /Claude on the web, desktop or phone.*docs\/deploy\.md.*pnpm dev:public/,
    );
  });

  it('as the published command, sends people to the deploy guide by its URL, with no pnpm script', () => {
    const lines = localModeLines({ ...banner, created: true, packaged: true });
    expect(lines.at(-1)).toBe(
      `For Claude on the web, desktop or phone, which connect from the cloud, see ${DEPLOY_GUIDE_URL}: a tunnel or a host.`,
    );
    expect(DEPLOY_GUIDE_URL).toBe(
      'https://github.com/PaulMRamirez/tabdock/blob/main/docs/deploy.md',
    );
    expect(lines.join('\n')).not.toContain('pnpm');
  });

  it('after --new-token, says the helper needs no change, and that a --header entry must be replaced', () => {
    const helper = localModeLines({ ...banner, created: true, replaced: true }).join('\n');
    expect(helper).toContain(`Owner token:   ${banner.tokenPath} (created just now)`);
    expect(helper).toContain(
      "The token is new. Claude Code's entry needs no change: the helper reads the new token at its next connection.",
    );
    for (const header of [
      localModeLines({ ...banner, created: true, replaced: true, shell: 'powershell' }),
      localModeLines({
        ...banner,
        tokenPath: '/home/me/$weird/tabdock/owner-token',
        created: true,
        replaced: true,
      }),
    ]) {
      expect(header.join('\n')).toContain(
        "The token is new, so replace Claude Code's entry: claude mcp remove --scope user tabdock-local, then the command above.",
      );
    }
  });

  it('says when the token was kept from an earlier start, and still how to replace an older entry', () => {
    const text = localModeLines({ ...banner, created: false }).join('\n');
    expect(text).toContain(`${banner.tokenPath} (kept from an earlier start)`);
    // An earlier start that never listened may have drawn it, so Claude Code
    // may hold an older token under the same name: the way out is always shown.
    expect(text).toMatch(
      /If Claude Code says tabdock-local already exists, .*claude mcp remove --scope user tabdock-local/,
    );
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
    expect(text).not.toContain('add-json');
    expect(text).not.toContain('Header helper');
  });
});

describe('the claude mcp add-json line (ADR 0028)', () => {
  it('prints the helper bare on Linux and in double quotes on macOS, from JSON.stringify through quotePosix', () => {
    expect(claudeAddJsonCommand(MCP_URL, '/home/u/.config/tabdock/claude-headers')).toBe(
      `claude mcp add-json --scope user tabdock-local '{"type":"http","url":"http://127.0.0.1:8787/mcp","headersHelper":"/home/u/.config/tabdock/claude-headers"}'`,
    );
    expect(
      claudeAddJsonCommand(MCP_URL, '/Users/u/Library/Application Support/Tabdock/claude-headers'),
    ).toBe(
      `claude mcp add-json --scope user tabdock-local '{"type":"http","url":"http://127.0.0.1:8787/mcp","headersHelper":"\\"/Users/u/Library/Application Support/Tabdock/claude-headers\\""}'`,
    );
    // A single quote in the path is closed, escaped and reopened by quotePosix.
    expect(claudeAddJsonCommand(MCP_URL, "/home/o'brien/x")).toBe(
      `claude mcp add-json --scope user tabdock-local '{"type":"http","url":"http://127.0.0.1:8787/mcp","headersHelper":"\\"/home/o'\\''brien/x\\""}'`,
    );
  });

  it('falls back to the --header line for a path double quotes cannot carry', () => {
    for (const odd of ['"', '\\', '$', '`', '\n', '\t', '\u0007', '\u007f', '\u0085']) {
      const tokenPath = `/home/u/a${odd}b/tabdock/owner-token`;
      expect(helperCommand(headersHelperPath(tokenPath)), JSON.stringify(odd)).toBeNull();
      expect(claudeCommandFor('posix', MCP_URL, tokenPath)).toEqual({
        line: claudeAddCommand('posix', MCP_URL, tokenPath),
        helper: false,
      });
    }
    // PowerShell keeps the --header line whatever the path.
    expect(claudeCommandFor('powershell', MCP_URL, 'C:\\Users\\me\\Tabdock\\owner-token')).toEqual({
      line: claudeAddCommand('powershell', MCP_URL, 'C:\\Users\\me\\Tabdock\\owner-token'),
      helper: false,
    });
  });

  // Each directory name is a real TABDOCK_HOME. Through sh -c the printed line
  // must give the stub claude exactly add-json's arguments, and the
  // headersHelper in that JSON, run through each shell as Claude Code runs it,
  // must print exactly the header for the token on disk.
  const MATRIX: { name: string; helper: 'bare' | 'quoted' | 'fallback' }[] = [
    { name: 'tabdock', helper: 'bare' },
    { name: 'tab.dock_1-2', helper: 'bare' },
    { name: 'Application Support', helper: 'quoted' },
    { name: "owner's tabdock", helper: 'quoted' },
    { name: "it's 'quoted' twice", helper: 'quoted' },
    { name: 'a&b;c|d<e>f(g)h', helper: 'quoted' },
    { name: 'glob*?[ab]{c,d}~#%^!=+@,:', helper: 'quoted' },
    { name: 'tabdöck ☃ 東京', helper: 'quoted' },
    { name: '-leading dash', helper: 'quoted' },
    { name: 'a "double" quote', helper: 'fallback' },
    { name: 'a\\backslash', helper: 'fallback' },
    { name: 'a $HOME b', helper: 'fallback' },
    { name: 'a `id` b', helper: 'fallback' },
    { name: 'a\nnewline', helper: 'fallback' },
    { name: 'a\ttab', helper: 'fallback' },
  ];
  const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((shell) =>
    existsSync(shell),
  );

  for (const { name, helper } of MATRIX) {
    it.skipIf(!POSIX)(`a token directory named ${JSON.stringify(name)}: ${helper}`, () => {
      const dir = scratch();
      const owner = loadOwnerToken({ TABDOCK_HOME: join(dir, name) });
      const command = claudeCommandFor('posix', MCP_URL, owner.path);
      expect(command.helper).toBe(helper !== 'fallback');
      const lines = localModeLines({
        mcpUrl: MCP_URL,
        pageUrl: 'ws://127.0.0.1:8787/page',
        tokenPath: owner.path,
        created: true,
        shell: 'posix',
      });
      expect(lines).toContain(`  ${command.line}`);
      expect(leakIn(lines.join('\n'), owner.token)).toBeNull();
      const bin = stubClaude(dir);
      const out = join(dir, 'arguments');
      for (const shell of SHELLS) {
        const ran = spawnSync(shell, ['-c', command.line], {
          env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TABDOCK_STUB_OUT: out },
          encoding: 'utf8',
        });
        expect(ran.status, `${shell}: ${ran.stderr}`).toBe(0);
        const given = argumentsIn(out);
        if (helper === 'fallback') {
          expect(given.slice(0, -1), shell).toEqual(EXPECTED_HEAD);
          expect(given.at(-1) === `Authorization: Bearer ${owner.token}`, shell).toBe(true);
          continue;
        }
        expect(given.slice(0, 5), shell).toEqual([
          'mcp',
          'add-json',
          '--scope',
          'user',
          LOCAL_SERVER_NAME,
        ]);
        expect(given).toHaveLength(6);
        const json: unknown = JSON.parse(given[5] ?? '');
        expect(json).toEqual({
          type: 'http',
          url: MCP_URL,
          headersHelper:
            helper === 'bare'
              ? headersHelperPath(owner.path)
              : `"${headersHelperPath(owner.path)}"`,
        });
        expect(leakIn(given.join('\n'), owner.token)).toBeNull();
        // Claude Code runs the helper's command through a shell; every shell must find the script.
        const helperRun = (json as { headersHelper: string }).headersHelper;
        for (const runner of SHELLS) {
          const printed = spawnSync(runner, ['-c', helperRun], { env: {}, encoding: 'utf8' });
          expect(printed.status, `${shell} then ${runner}: ${printed.stderr}`).toBe(0);
          expect(printed.stdout === `{"Authorization":"Bearer ${owner.token}"}\n`).toBe(true);
        }
      }
    });
  }
});
