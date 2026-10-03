// ADR 0010: only the worker thread runs CfWorker. Here the validator module is
// replaced, for this test file's main thread only, by one that counts every
// provider made and every schema compiled; the worker thread loads the real
// module on its own, outside this file's mocks. A tools frame and calls through
// the relay must leave both counts at zero while invalid calls are still refused.

import type { Client } from '@modelcontextprotocol/client';
import type { PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectPage, type TestPage } from './helpers/page-client.ts';
import {
  ALICE,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const seen = vi.hoisted(() => ({ providers: 0, compiled: 0 }));

vi.mock('@modelcontextprotocol/server/validators/cf-worker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/server/validators/cf-worker')>();
  type Provider = InstanceType<typeof actual.CfWorkerJsonSchemaValidator>;
  class CountingValidator extends actual.CfWorkerJsonSchemaValidator {
    constructor(...options: ConstructorParameters<typeof actual.CfWorkerJsonSchemaValidator>) {
      super(...options);
      seen.providers += 1;
    }

    override getValidator<T>(schema: Parameters<Provider['getValidator']>[0]) {
      seen.compiled += 1;
      return super.getValidator<T>(schema);
    }
  }
  return { ...actual, CfWorkerJsonSchemaValidator: CountingValidator };
});

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

const FORM: PageTool = {
  name: 'fill_form',
  description: 'A tool with an ordinary schema.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, tags: { type: 'array', uniqueItems: true } },
    required: ['name'],
  },
  annotations: { readOnlyHint: true },
};

describe('CfWorker never runs on the relay main thread (ADR 0010)', () => {
  it('compiles nothing on the main thread for a tools frame, a re-sent one or calls, and still refuses invalid arguments', async () => {
    current = await startRelay();
    const page = await connectPage(current.relay.pageUrl, {
      tools: [FORM],
      onInvoke: () => ({ ok: true, content: 'done' }),
    });
    pages.push(page);
    page.send({ t: 'tools', tools: [FORM] });
    await page.sync();
    const alice = await connectClient(current.relay, ALICE);
    clients.push(alice);
    await pairAndApprove(alice, page);

    const call = (args: Record<string, unknown>) =>
      callTool(alice, 'call_page_tool', { page: page.pageId, tool: 'fill_form', arguments: args });
    expect((await call({ name: 'Ada', tags: ['a', 'b'] })).isError).toBe(false);
    expect((await call({ name: 7 })).text).toBe(
      'invalid_arguments: the arguments for tool fill_form do not match its inputSchema: arguments/name has the wrong type (rule "type")',
    );
    expect(seen).toEqual({ providers: 0, compiled: 0 });
  });
});
