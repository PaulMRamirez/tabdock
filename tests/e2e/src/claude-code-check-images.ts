// Image results as Claude Code hands them to its model (ADR 0039, A6.5):
//   pnpm --filter @tabdock/e2e check:claude-code:images
//   pnpm --filter @tabdock/e2e check:claude-code:images -- --live
// Both need `claude` on the PATH; without it the check skips and says so,
// since Claude Code is not a repo dependency.
//
// By default Claude Code talks to a scripted stand-in for the Messages API on
// loopback, as check:claude-code:labels does, so it needs no sign-in and makes
// no model call: the stand-in asks for a capture at 64, 128, 256 and 512 KiB
// and records the tool_result Claude Code hands back, which is what the model
// would read. The check passes when the 64 KiB picture (DEFAULT_IMAGE_BYTES)
// reaches the model as an image block after the label, and reports what
// Claude Code did with the larger ones, under its default MAX_MCP_OUTPUT_TOKENS.
//
// With --live it runs against the signed-in Claude Code instead and asks the
// model which digit a 64 KiB PNG shows, which proves the model sees the
// picture rather than only receiving it. That spends the owner's own usage,
// so only the owner runs it, from the M6 checklist; a failure there lowers
// DEFAULT_IMAGE_BYTES in 8 KiB steps (ADR 0039, decision 2).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_IMAGE_BYTES, MAX_IMAGE_BYTES, untrustedHeader } from '@tabdock/protocol';
import { createDevTokenAuth, createRelay, type DevTokenUser, type Relay } from '@tabdock/relay';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import {
  base64Of,
  DEFAULT_SIM_ORIGIN,
  pngImage,
  type SimPage,
  startSimPage,
} from '@tabdock/sim-page';

const SERVER = 'tabdock';
const TOOL = `mcp__${SERVER}__call_page_tool`;
/** Claude Code expands ${VAR} in headers, so the token reaches it through the environment and never touches disk. */
const TOKEN_VARIABLE = 'TABDOCK_IMAGES_CHECK_TOKEN';
const SIZES = [DEFAULT_IMAGE_BYTES, 131_072, 262_144, MAX_IMAGE_BYTES] as const;
const live = process.argv.includes('--live');
const say = (text: string): void => {
  console.log(text);
};

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error !== undefined || version.status !== 0) {
  say(
    'check:claude-code:images skipped: no `claude` on the PATH. Claude Code is not a repo dependency, so the M6 checklist keeps this check for a run by hand.',
  );
  process.exit(0);
}

/** Seven rows of five columns for each digit, as on a small display. */
const DIGITS: Record<number, string[]> = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/** A white 300 by 300 PNG with one black digit filling its middle, padded to exactly `bytes`. */
function digitPng(digit: number, bytes: number): Uint8Array {
  const rows = DIGITS[digit] ?? DIGITS[0] ?? [];
  const cell = 30;
  const left = (300 - 5 * cell) / 2;
  const top = (300 - 7 * cell) / 2;
  return pngImage({
    width: 300,
    height: 300,
    padToBytes: bytes,
    paint: (x, y) => {
      const column = Math.floor((x - left) / cell);
      const row = Math.floor((y - top) / cell);
      const on = rows[row]?.[column] === '1';
      return on ? [0, 0, 0] : [255, 255, 255];
    },
  });
}

/** Pairs alice with the page through an SDK client of her own, the operator allowing a driver. */
async function attachAlice(relay: Relay, alice: DevTokenUser, sim: SimPage): Promise<string> {
  const client = new Client({ name: 'images-check-setup', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${alice.token}` } },
    }),
  );
  try {
    const state = await sim.waitFor((s) => s.link === 'linked' && s.pairing !== null);
    if (!state.pairing) throw new Error('the page shows no pairing code');
    const pending = client.callTool({ name: 'pair_page', arguments: { code: state.pairing.code } });
    const asked = await sim.waitFor((s) => s.pendingRequests.length > 0);
    const request = asked.pendingRequests[0];
    if (!request || !sim.dock.approve(request.requestId, 'driver')) {
      throw new Error('the operator could not approve the attach request');
    }
    const outcome = await pending;
    const page = (outcome.structuredContent as { page?: unknown } | undefined)?.page;
    if (outcome.isError === true || typeof page !== 'string') throw new Error('pair_page failed');
    return page;
  } finally {
    await client.close();
  }
}

type Event = [string, Record<string, unknown>];

/** One streamed assistant message, as the Messages API sends it. */
function message(block: Record<string, unknown>, stop: 'tool_use' | 'end_turn'): Event[] {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${randomBytes(6).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model: 'stand-in',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  const opened =
    block.type === 'text'
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: block.id, name: block.name, input: {} };
  const delta =
    block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
  return [
    ['message_start', start],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: opened }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
}

function stream(response: ServerResponse, events: Event[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [name, data] of events)
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

interface ApiRequest {
  stream?: boolean;
  tools?: { name?: unknown }[];
  messages?: { role?: unknown; content?: unknown }[];
}

/** What Claude Code handed the model for one capture. */
interface Seen {
  /** The blocks of the tool_result, in order, by type. */
  types: string[];
  /** The first text block. */
  text: string;
  /** Base64 characters of the first image block, or 0. */
  imageChars: number;
  mediaType: string;
  /** Any text Claude Code put after the image, such as where it saved the original. */
  after: string;
}

/**
 * The stand-in for the Messages API: each request that offers the relay's
 * tools gets the next capture, and the tool_result blocks in it are recorded
 * by tool_use id. Anything else Claude Code asks for on the side gets a short
 * reply, so it never stalls the run.
 */
async function startStandIn(
  inputs: Record<string, unknown>[],
): Promise<{ url: string; seen: Map<string, Seen>; close(): Promise<void> }> {
  const seen = new Map<string, Seen>();
  let next = 0;
  const server = createServer((request, response) => {
    void bodyOf(request).then((raw) => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const body = JSON.parse(raw) as ApiRequest;
      const ours = (body.tools ?? []).some((tool) => tool.name === TOOL);
      const reply = (block: Record<string, unknown>, stop: 'tool_use' | 'end_turn'): void => {
        if (body.stream === true) {
          stream(response, message(block, stop));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'msg_side',
            type: 'message',
            role: 'assistant',
            model: 'stand-in',
            content: [block],
            stop_reason: stop,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      };
      if (!ours) {
        reply({ type: 'text', text: 'ok' }, 'end_turn');
        return;
      }
      for (const turn of body.messages ?? []) {
        if (turn.role !== 'user' || !Array.isArray(turn.content)) continue;
        for (const block of turn.content as Record<string, unknown>[]) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const content = Array.isArray(block.content)
            ? (block.content as Record<string, unknown>[])
            : [{ type: 'text', text: String(block.content) }];
          const image = content.find((part) => part.type === 'image');
          const source = (image?.source ?? {}) as { data?: unknown; media_type?: unknown };
          const text = content.find((part) => part.type === 'text');
          seen.set(block.tool_use_id, {
            types: content.map((part) => String(part.type)),
            text: typeof text?.text === 'string' ? text.text : '',
            imageChars: typeof source.data === 'string' ? source.data.length : 0,
            mediaType: typeof source.media_type === 'string' ? source.media_type : '',
            after: content
              .slice(content.indexOf(image ?? {}) + 1)
              .map((part) => (typeof part.text === 'string' ? part.text : ''))
              .join(' '),
          });
        }
      }
      const input = inputs[next];
      if (input === undefined) {
        reply({ type: 'text', text: 'done' }, 'end_turn');
        return;
      }
      next += 1;
      reply({ type: 'tool_use', id: `toolu_step${String(next)}`, name: TOOL, input }, 'tool_use');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

/** The environment without this repo's and Claude's own settings, and with loopback unproxied. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith('TABDOCK_') &&
      !name.startsWith('ANTHROPIC_') &&
      !name.startsWith('CLAUDE_')
    ) {
      env[name] = value;
    }
  }
  env.NO_PROXY = ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY].filter(Boolean).join(',');
  env.no_proxy = ['localhost', '127.0.0.1', '::1', process.env.no_proxy].filter(Boolean).join(',');
  return env;
}

const dir = await mkdtemp(join(privateTempRoot(), 'tabdock-cc-images-'));
const alice: DevTokenUser = {
  userId: 'alice',
  displayName: 'Alice',
  token: `alice-${randomBytes(24).toString('base64url')}`,
};
let relay: Relay | undefined;
let sim: SimPage | undefined;
let passed = false;
const digit = randomInt(2, 10);

try {
  say(
    `Claude Code ${version.stdout.trim()}, ${live ? 'signed in, live' : 'against a stand-in for the Messages API'}`,
  );
  // The ceiling, so every size reaches Claude Code and only it decides what the model sees.
  relay = await createRelay({
    auth: createDevTokenAuth([alice]),
    port: 0,
    allowMissingOrigin: false,
    limits: { imageBytes: MAX_IMAGE_BYTES },
    logSink: () => undefined,
  });
  sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy: { imageTools: ['capture_digit'] },
    tools: () => [
      {
        name: 'capture_digit',
        title: 'Capture digit',
        description: 'Return a picture of the board, which shows one large digit.',
        inputSchema: {
          type: 'object',
          properties: { bytes: { type: 'integer', minimum: 4096, maximum: MAX_IMAGE_BYTES } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: (input) => {
          const asked = (input as { bytes?: unknown } | null)?.bytes;
          const bytes = typeof asked === 'number' ? asked : DEFAULT_IMAGE_BYTES;
          return {
            image: { mimeType: 'image/png', data: base64Of(digitPng(digit, bytes)) },
            text: `A picture of ${String(bytes)} bytes`,
          };
        },
      },
    ],
  });
  const pageId = await attachAlice(relay, alice, sim);
  const label = untrustedHeader(DEFAULT_SIM_ORIGIN, 'capture_digit');
  const home = join(dir, live ? 'home-live' : 'home-stand-in');
  await mkdir(home, { recursive: true });
  const configPath = join(home, 'mcp.json');
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        [SERVER]: {
          type: 'http',
          url: relay.mcpUrl,
          headers: { Authorization: `Bearer \${${TOKEN_VARIABLE}}` },
        },
      },
    }),
  );

  if (live) {
    // The owner's own Claude Code, signed in as they left it: their HOME and settings.
    const env = { ...process.env, [TOKEN_VARIABLE]: alice.token };
    const output = await run(
      home,
      [
        '-p',
        `Call ${TOOL} with page ${pageId}, tool capture_digit and arguments {"bytes": ${String(DEFAULT_IMAGE_BYTES)}}. The picture shows one digit. Answer with that digit alone.`,
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--allowedTools',
        TOOL,
        '--permission-mode',
        'dontAsk',
        '--max-turns',
        '4',
        '--output-format',
        'json',
      ],
      env,
    );
    const answer = (() => {
      try {
        const result = (JSON.parse(output) as { result?: unknown }).result;
        return typeof result === 'string' ? result : '';
      } catch {
        return '';
      }
    })();
    passed = answer.trim().startsWith(String(digit));
    say(
      `${passed ? 'PASS' : 'FAIL'}  the model was shown a ${String(DEFAULT_IMAGE_BYTES)}-byte PNG of the digit ${String(digit)} and answered ${JSON.stringify(answer.trim().slice(0, 40))}`,
    );
  } else {
    const inputs = SIZES.map((bytes) => ({
      page: pageId,
      tool: 'capture_digit',
      arguments: { bytes },
    }));
    const standIn = await startStandIn(inputs);
    const config = join(home, '.claude-config');
    await mkdir(config, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: config,
      // Not a key: the stand-in takes any, and nothing leaves loopback.
      ANTHROPIC_API_KEY: 'stand-in',
      ANTHROPIC_BASE_URL: standIn.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      [TOKEN_VARIABLE]: alice.token,
    };
    await run(
      home,
      [
        '-p',
        'Run the steps.',
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--allowedTools',
        TOOL,
        '--permission-mode',
        'dontAsk',
        '--max-turns',
        String(SIZES.length + 2),
        '--output-format',
        'json',
      ],
      env,
    );
    await standIn.close();
    say('\nWhat Claude Code handed its model, at its default MAX_MCP_OUTPUT_TOKENS:');
    for (const [index, bytes] of SIZES.entries()) {
      const result = standIn.seen.get(`toolu_step${String(index + 1)}`);
      const image = result !== undefined && result.imageChars > 0;
      const labelled = result?.text.startsWith(label) === true;
      const what =
        result === undefined
          ? 'no tool_result'
          : image
            ? `${result.types.join(' + ')}, an ${result.mediaType} of ${String(result.imageChars)} base64 characters, ${labelled ? 'after the label' : 'WITHOUT the label first'}${result.after === '' ? '' : `; then ${JSON.stringify(result.after.replace(dir, '<dir>').slice(0, 160))}`}`
            : `${result.types.join(' + ')} and no image: ${JSON.stringify(result.text.slice(0, 120))}`;
      say(`  ${String(bytes / 1024).padStart(3)} KiB  ${what}`);
      if (bytes === DEFAULT_IMAGE_BYTES) passed = image && labelled;
    }
    say(
      `\n${passed ? 'PASS' : 'FAIL'}  the default cap's picture reaches the model as an image after its label`,
    );
  }
} finally {
  await sim?.close();
  await relay?.close();
  await rm(dir, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
