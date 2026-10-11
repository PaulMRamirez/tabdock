// A stand-in for headless Claude Code in the advisory runner's tests: it
// prints stream-json events as Claude Code 2.1.296 does for one scenario,
// writes its process id to a file so a test can see whether it still runs,
// and either ends or waits until it is killed.
//   node fake-claude.ts <scenario> <pid file>

import { writeFileSync } from 'node:fs';

const [scenario = '', pidFile = ''] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));

const TABDOCK = [
  'mcp__tabdock__call_page_tool',
  'mcp__tabdock__get_page_state',
  'mcp__tabdock__list_page_tools',
  'mcp__tabdock__list_pages',
  'mcp__tabdock__pair_page',
];
const init = (tools: string[]): object => ({
  type: 'system',
  subtype: 'init',
  cwd: '/scratch',
  tools,
  mcp_servers: [{ name: 'tabdock', status: 'connected', source: 'dynamic' }],
  permissionMode: 'dontAsk',
});
const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } };
const print = (event: object): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
/** Waits until killed: a run that would otherwise go on spending turns. */
const hang = (): void => {
  setInterval(() => undefined, 60_000);
};

switch (scenario) {
  case 'contained':
    // Notices may come first: a hook's, and one Claude Code 2.1.296 sends in a session with a goal.
    print({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' });
    print({ type: 'active_goal' });
    print(init(TABDOCK));
    print(assistant);
    print({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'VERDICT tour 0 ok the crater is there\nVERDICT tour 1 doubt too dark\nThanks.',
    });
    break;
  case 'shell':
    print(init(['Task', 'Bash', 'Read', 'WebFetch', ...TABDOCK]));
    hang();
    break;
  case 'early':
    print(assistant);
    hang();
    break;
  case 'hang':
    print(init(TABDOCK));
    hang();
    break;
  default:
    // Says nothing and ends, as a Claude Code that reports no init event would.
    break;
}
