// Agent tokens (ADR 0044) from the outside: a page mints one as the adapter
// does, with a token of its own whose SHA-256 alone it sends, and an agent
// reaches /g/mcp through the stand-in tunnel with `Authorization: Bearer`,
// either as an MCP SDK client or as raw requests a test shapes by hand.

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  AGENT_PATH,
  agentKeyInput,
  INVITEE_ID_PREFIX,
  INVITEE_KEY_HEX_CHARS,
  type RelayFrame,
} from '@tabdock/protocol';
import { latest } from './invites.ts';
import type { TestPage } from './page-client.ts';
import { PUBLIC_ORIGIN, type RawAnswer, tunnelFetch } from './tunnel.ts';
import { answerOf, MODERN, type WireAnswer } from './wire.ts';

export const AGENT_URL = `${PUBLIC_ORIGIN}${AGENT_PATH}`;

export type AgentsFrame = Extract<RelayFrame, { t: 'agents' }>;

/** A fresh token as the adapter draws one, and the digest the relay keeps. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `tda_${randomBytes(32).toString('base64url')}`;
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/** The agent user a token's requests come from: g_ and a digest of the page and token ids. */
export function agentUserId(pageId: string, tokenId: string): string {
  const hex = createHash('sha256').update(agentKeyInput(pageId, tokenId), 'utf8').digest('hex');
  return `${INVITEE_ID_PREFIX}${hex.slice(0, INVITEE_KEY_HEX_CHARS)}`;
}

let nextToken = 0;

export interface AgentMintOptions {
  label?: string;
  expiresAt?: number;
  tokenId?: string;
  /** Mint this token rather than a fresh one. */
  token?: string;
}

/** Mints a token on the page and returns it, its id and the relay's answer. */
export async function mintAgent(
  page: TestPage,
  options: AgentMintOptions = {},
): Promise<{ token: string; hash: string; tokenId: string; answer: AgentsFrame }> {
  const fresh = newAgentToken();
  const token = options.token ?? fresh.token;
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  nextToken += 1;
  const tokenId = options.tokenId ?? `agt_${String(nextToken)}`;
  page.send({
    t: 'agent_create',
    tokenId,
    label: options.label ?? 'Lab agent',
    expiresAt: options.expiresAt ?? Date.now() + 60 * 60_000,
    secretHash: hash,
  });
  // The relay answers an agent_create at once, so its answer is the newest frame.
  const answer = await latest(page, 'agents');
  return { token, hash, tokenId, answer };
}

/**
 * One raw request to /g/mcp through the stand-in tunnel, answered whole:
 * `token` null sends no Authorization header, and `headers` adds or
 * replaces any, the Host and Origin included.
 */
export function agentRequest(
  relayUrl: string,
  token: string | null,
  body: unknown,
  options: { method?: string; headers?: Record<string, string>; path?: string } = {},
): Promise<RawAnswer> {
  const host = new URL(PUBLIC_ORIGIN).host;
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(options.path ?? AGENT_PATH, relayUrl),
      {
        method: options.method ?? 'POST',
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/** A JSON-RPC tools/call body for raw requests. */
export function toolCall(name: string, args: Record<string, unknown>, id = 1): unknown {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

/**
 * An MCP SDK client on /g/mcp with the token as its bearer, named `name`, as
 * Claude Code connects with the printed command's --header. Its initialize
 * is answered at once, so this resolves before the operator is asked; the
 * prompt its first request raised is then waiting on the page.
 */
export async function connectAgent(
  relayUrl: string,
  token: string,
  name = 'claude-code',
): Promise<Client> {
  const client = new Client({ name, version: '2.1.287' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(AGENT_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: tunnelFetch(relayUrl),
    }),
  );
  return client;
}

/** What wire.ts's exchanges read back, on /g/mcp with a token as the bearer. */
export interface AgentWire {
  /** A 2025-era initialize, acknowledged, its session left open. */
  legacyInitialize(): Promise<WireAnswer & { sessionId: string | null }>;
  /** One request on that session. */
  legacy(sessionId: string, method: string, params?: Record<string, unknown>): Promise<WireAnswer>;
  /** One 2026-07-28 request, with the envelope and headers the SDK client sends. */
  modern(method: string, params?: Record<string, unknown>): Promise<WireAnswer>;
}

/**
 * wire.ts's exchanges on /g/mcp through the stand-in tunnel, read back
 * exactly as they crossed the wire, so the fixed tools' golden test can hold
 * what an agent receives to what a member does on /mcp (ADR 0044).
 */
export function agentWire(relayUrl: string, token: string): AgentWire {
  const send = tunnelFetch(relayUrl);
  let nextId = 9000;
  const post = async (
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; sessionId: string | null; text: string }> => {
    const response = await send(AGENT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      sessionId: response.headers.get('mcp-session-id'),
      text: await response.text(),
    };
  };
  const onSession = (sessionId: string): Record<string, string> => ({
    'Mcp-Session-Id': sessionId,
    'Mcp-Protocol-Version': '2025-11-25',
  });
  return {
    async legacyInitialize() {
      nextId += 1;
      const id = nextId;
      const { status, sessionId, text } = await post({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'wire-test', version: '1.0.0' },
        },
      });
      if (sessionId !== null) {
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, onSession(sessionId));
      }
      return { status, message: answerOf(text, id), body: text, sessionId };
    },
    async legacy(sessionId, method, params = {}) {
      nextId += 1;
      const id = nextId;
      const { status, text } = await post(
        { jsonrpc: '2.0', id, method, params },
        onSession(sessionId),
      );
      return { status, message: answerOf(text, id), body: text };
    },
    async modern(method, params = {}) {
      nextId += 1;
      const id = nextId;
      const meta = {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      };
      const { status, text } = await post(
        { jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } },
        {
          'Mcp-Protocol-Version': MODERN,
          'Mcp-Method': method,
          ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
        },
      );
      return { status, message: answerOf(text, id), body: text };
    },
  };
}
