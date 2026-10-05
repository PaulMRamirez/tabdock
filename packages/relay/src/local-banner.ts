// What local mode prints at start (ADRs 0022 and 0028), for the relay alone
// (main.ts, cli.ts) and for pnpm dev: that it serves this computer only, where
// to connect, where the owner token lives, and a command that adds the relay
// to Claude Code without the token ever being in it.
//
// On POSIX shells that command is `claude mcp add-json --scope user` with a
// headersHelper: Claude Code runs the helper beside the token at each
// connection, so the token is in neither claude's argument list nor Claude
// Code's settings (ADR 0028). Claude Code runs the helper through a shell, so
// its path goes bare when it is a plain word and in double quotes otherwise
// (macOS's holds `Application Support`); a path that double quotes cannot
// carry safely falls back to ADR 0022's `--header` line, which reads the token
// from its file as it runs. PowerShell keeps that line, since Windows gets no
// helper until a Windows run shows which shell runs one there.
//
// User scope offers the relay in every project and keeps the token out of
// repositories, which only the project scope would write to, and needs no trust
// dialog for a helper; the name tabdock-local leaves `tabdock` for a hosted
// connector. Checking goes through `claude mcp list`, since `claude mcp get`
// prints a stored header in full.

import { headersHelperPath } from './local-token.ts';
import { DEPLOY_GUIDE_URL } from './packaged.ts';
import { quotePosix, quotePowerShell } from './shell-quote.ts';

export { quotePosix, quotePowerShell };

export type Shell = 'posix' | 'powershell';

/** The Claude Code server name local mode suggests. */
export const LOCAL_SERVER_NAME = 'tabdock-local';

/** The shell whose command the banner prints: PowerShell on Windows, a POSIX shell elsewhere. */
export function shellFor(platform: NodeJS.Platform): Shell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** A URL as one word: left bare when it is plain, as the default always is, quoted otherwise. */
function urlWord(shell: Shell, url: string): string {
  if (/^[A-Za-z0-9:/._-]+$/.test(url)) return url;
  return shell === 'posix' ? quotePosix(url) : quotePowerShell(url);
}

/** ADR 0022's command: adds the relay with a header that reads the token from its file as it runs. */
export function claudeAddCommand(shell: Shell, mcpUrl: string, tokenPath: string): string {
  const read =
    shell === 'posix'
      ? `$(cat ${quotePosix(tokenPath)})`
      : `$(Get-Content -TotalCount 1 -LiteralPath ${quotePowerShell(tokenPath)})`;
  return `claude mcp add --transport http --scope user ${LOCAL_SERVER_NAME} ${urlWord(shell, mcpUrl)} --header "Authorization: Bearer ${read}"`;
}

/**
 * The helper's path as the shell command Claude Code runs: bare when it holds
 * only letters, digits and `/._-`, in double quotes otherwise, or null when it
 * holds a double quote, a backslash, `$`, a backtick or a control character,
 * which double quotes cannot carry safely.
 */
export function helperCommand(helperPath: string): string | null {
  if (/^[A-Za-z0-9/._-]+$/.test(helperPath)) return helperPath;
  if (/[\p{Cc}"\\$`]/u.test(helperPath)) return null;
  return `"${helperPath}"`;
}

/**
 * ADR 0028's command for POSIX shells: the server's JSON, from JSON.stringify,
 * as one single-quoted word. Null when the helper's path cannot be carried,
 * and the caller prints claudeAddCommand's line instead.
 */
export function claudeAddJsonCommand(mcpUrl: string, helperPath: string): string | null {
  const command = helperCommand(helperPath);
  if (command === null) return null;
  const json = JSON.stringify({ type: 'http', url: mcpUrl, headersHelper: command });
  return `claude mcp add-json --scope user ${LOCAL_SERVER_NAME} ${quotePosix(json)}`;
}

/** The command the banner prints for a shell, and whether it goes through the helper. */
export function claudeCommandFor(
  shell: Shell,
  mcpUrl: string,
  tokenPath: string,
): { line: string; helper: boolean } {
  if (shell === 'posix') {
    const line = claudeAddJsonCommand(mcpUrl, headersHelperPath(tokenPath));
    if (line !== null) return { line, helper: true };
  }
  return { line: claudeAddCommand(shell, mcpUrl, tokenPath), helper: false };
}

export interface LocalBanner {
  mcpUrl: string;
  pageUrl: string;
  tokenPath: string;
  /** Whether this start drew the token. */
  created: boolean;
  shell: Shell;
  /** Whether this start replaced the token on request (--new-token). */
  replaced?: boolean | undefined;
  /** Whether this is the published command, which has no docs/ and no pnpm dev:public. */
  packaged?: boolean | undefined;
}

/**
 * The local mode lines both banners share; the last one points the way to
 * Claude in the cloud. The step for an older entry shows on every start, not
 * only when the token is new: a start that drew the token and then could not
 * listen leaves the next start reporting it kept, while Claude Code may still
 * hold an earlier token or an M4 entry under the same name, and Claude Code
 * refuses to replace an entry. Removing an M4 entry also removes the copy of
 * the token it kept in ~/.claude.json.
 */
export function localModeLines(banner: LocalBanner): string[] {
  const command = claudeCommandFor(banner.shell, banner.mcpUrl, banner.tokenPath);
  const helper = headersHelperPath(banner.tokenPath);
  const replaced =
    banner.replaced !== true
      ? []
      : command.helper
        ? [
            "The token is new. Claude Code's entry needs no change: the helper reads the new token at its next connection.",
          ]
        : [
            `The token is new, so replace Claude Code's entry: claude mcp remove --scope user ${LOCAL_SERVER_NAME}, then the command above.`,
          ];
  return [
    'Local mode: this relay serves MCP clients on this computer only, and trusts every account on it (ADR 0022).',
    `  MCP endpoint:  ${banner.mcpUrl}`,
    `  Page socket:   ${banner.pageUrl}`,
    `  Owner token:   ${banner.tokenPath} (${banner.created ? 'created just now' : 'kept from an earlier start'})`,
    ...(command.helper ? [`  Header helper: ${helper} (holds no token)`] : []),
    '',
    command.helper
      ? 'Add the relay to Claude Code; Claude Code runs the header helper at each connection to read the token, so neither this command nor its settings hold it:'
      : 'Add the relay to Claude Code; the command reads the token from that file, so it is never shown:',
    `  ${command.line}`,
    `If Claude Code says ${LOCAL_SERVER_NAME} already exists, remove the old entry first: claude mcp remove --scope user ${LOCAL_SERVER_NAME}`,
    ...replaced,
    'Check the connection with: claude mcp list',
    'Then ask Claude to pair with the code in the Tabdock widget, and approve the request on the page.',
    banner.packaged === true
      ? `For Claude on the web, desktop or phone, which connect from the cloud, see ${DEPLOY_GUIDE_URL}: a tunnel or a host.`
      : 'For Claude on the web, desktop or phone, which connect from the cloud, see the top of docs/deploy.md: a tunnel (pnpm dev:public) or a host.',
  ];
}
