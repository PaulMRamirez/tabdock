// Leg 7 of pnpm demo:m6 (ADR 0044): the teacher mints an agent token for an
// unattended checker in the widget's Invite form; the widget shows the
// `claude mcp add` command once, and Done leaves nothing of it. The agent's
// first request on /g/mcp raises an ordinary prompt that offers observer
// only; once allowed it reads the map and is refused a write. Cancel in the
// agent list ends the token, and from then on /g/mcp answers 404, which is
// how Claude Code's "endpoint not found" reads. The token itself is never
// printed: the narrator holds it and its digest as secrets.

import { createHash } from 'node:crypto';
import { waitingPrompts } from '@tabdock/adapter/testing';
import { AGENT_COMMAND, agentStatus, connectAgent } from '../agent-harness.ts';
import {
  callTool,
  clickInWidget,
  errorCode,
  typeInWidget,
  widgetItems,
  widgetText,
} from '../tabdock-harness.ts';
import { auditLines, bind, type Lesson, until } from './lesson.ts';
import { storyLine } from './narrator.ts';
import { allowIn, openPanel, shownLines, shownText, widgetTextWhen } from './operator.ts';

const LABEL = 'Nightly checker';

/** The id of the one attach prompt from a client of this name, once the widget shows it. */
async function promptFrom(lesson: Lesson, client: string): Promise<string> {
  const { page } = lesson.operator;
  return until(async () => {
    const cdp = await page.context().newCDPSession(page);
    try {
      const prompts = await waitingPrompts(cdp);
      return prompts.attach.find((prompt) => prompt.client === client)?.requestId ?? null;
    } finally {
      await cdp.detach();
    }
  }, `a prompt from ${client}`);
}

export async function agent(lesson: Lesson): Promise<void> {
  const { narrator, operator, pageId, room } = lesson;
  const { page } = operator;
  const { say, check } = bind(narrator);
  await openPanel(page);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', LABEL);
  await clickInWidget(page, { action: 'invite-kind-agent' });
  await clickInWidget(page, { action: 'agent-lifetime-1h' });
  await clickInWidget(page, { action: 'invite-create' });
  const command = await widgetTextWhen(page, 'agent-command', (text) => text !== '');
  const match = AGENT_COMMAND.exec(command);
  const [, , endpoint = '', token = ''] = match ?? [];
  narrator.remember(token);
  narrator.remember(createHash('sha256').update(token, 'utf8').digest('hex'));
  check(match !== null, 'the widget should show the agent command');
  say(`   The teacher mints "${LABEL}" for one hour in the Invite form; the widget shows, once:`);
  say(`   ${command.replace(/tda_[A-Za-z0-9_-]+/, 'tda_' + '*'.repeat(43))}`);
  await clickInWidget(page, { action: 'agent-done' });
  check((await widgetText(page, 'agent-command')) === '', 'Done should clear the command');
  const [row] = await widgetItems(page, 'agent-list');
  say('   Done clears it; the agent list reads:');
  for (const line of shownLines(await shownText(page, 'data-token-id', row?.data.tokenId ?? ''))) {
    say(`   | ${line}`);
  }

  const agentClient = await connectAgent(room.relay.url, token, 'claude-code');
  say(`   An agent connects to ${endpoint} with the token as its bearer, and calls pair_page:`);
  const pairing = callTool(agentClient, 'pair_page', {});
  const requestId = await promptFrom(lesson, 'claude-code');
  say('   The widget asks:');
  for (const line of shownLines(await shownText(page, 'data-request-id', requestId))) {
    say(`   | ${line}`);
  }
  await allowIn(page, 'claude-code', 'observer');
  const paired = await pairing;
  say(`   The teacher clicks Allow as observer: ${paired.text.split('\n', 1)[0] ?? ''}`);
  check(
    !paired.isError && paired.text.includes('as observer'),
    'the agent should attach as observer',
  );
  const read = await callTool(agentClient, 'call_page_tool', { page: pageId, tool: 'get_view' });
  const write = await callTool(agentClient, 'call_page_tool', {
    page: pageId,
    tool: 'set_view',
    arguments: { lat: 0, lon: 0 },
  });
  say(
    `   It reads get_view: ${read.isError ? 'refused' : 'ok'}; it tries set_view: ${errorCode(write) ?? 'ok'}`,
  );
  check(
    !read.isError && errorCode(write) === 'role_denied',
    'the agent should read and be refused a write',
  );

  await clickInWidget(page, { action: 'agent-cancel' });
  const status = await until(
    async () => ((await agentStatus(room.relay.url, token)) === 404 ? 404 : null),
    '/g/mcp to refuse the cancelled token',
  );
  say(
    `   The teacher clicks Cancel on its row; /g/mcp now answers ${String(status)} to the token, as to any miss.`,
  );
  for (const record of auditLines(room.auditDir).filter(
    (line) => line.type === 'agent_minted' || line.type === 'agent_closed',
  )) {
    say(`   ${storyLine(record)}`);
  }
  await agentClient.close().catch(() => undefined);
}
