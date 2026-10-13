# Scripts and the widget

A script can do what Claude does, and in a headless browser what the operator does. This page signs an SDK client in at a public relay, pairs a script with a page in headless Chromium, fills the widget's fields and lists the testing helper's calls. [Connect clients](05-connect-clients.md#any-mcp-client) has the shorter program for a token on the relay's computer.

## A client that signs in

A relay at a public URL takes tokens from its provider, which a person obtains by signing in. This program, for `@modelcontextprotocol/client` 2.3.1, prints the sign-in address, waits on a loopback port for the browser to come back, finishes the sign-in and connects again with the token, which it holds in memory only. The relay's provider must accept the program: by dynamic registration where it offers it, or with a public client you register for the loopback redirect, whose id you pass as `CLIENT_ID`; the SDK then warns once that the stored client has no issuer stamp, which is harmless here. Set it up as on Connect clients:

```sh
mkdir my-client && cd my-client
npm init -y && npm pkg set type=module
npm install --save-exact @modelcontextprotocol/client@2.3.1
```

Save this as `sign-in.ts` and run it as `node sign-in.ts`, then open the address it prints in a browser on the same computer:

```ts
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

const RELAY = new URL('https://relay.example/mcp');
const state = crypto.randomUUID();

// The provider sends the browser back here, on this computer only.
let received: (params: URLSearchParams) => void = () => undefined;
const callback = new Promise<URLSearchParams>((resolve) => {
  received = resolve;
});
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const ours = url.pathname === '/callback' && url.searchParams.get('state') === state;
  response.writeHead(ours ? 200 : 400, { 'Content-Type': 'text/plain' });
  response.end(ours ? 'Signed in; close this tab.' : 'Not a sign-in.');
  if (ours) received(url.searchParams);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no loopback port');
const callbackUrl = new URL('http://127.0.0.1/callback');
callbackUrl.port = String(address.port);
const redirect = callbackUrl.href;

/** The sign-in, held in memory for this run; nothing here prints a token. */
class SignIn implements OAuthClientProvider {
  #client: StoredOAuthClientInformation | undefined = process.env.CLIENT_ID
    ? { client_id: process.env.CLIENT_ID }
    : undefined;
  #tokens: StoredOAuthTokens | undefined;
  #verifier = '';
  #discovery: OAuthDiscoveryState | undefined;
  get redirectUrl(): string {
    return redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'my-script',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    return state;
  }
  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#client;
  }
  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.#client = info;
  }
  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL): void {
    console.log(`Sign in at ${url.href}`);
  }
  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }
  codeVerifier(): string {
    return this.#verifier;
  }
  // Without these two the SDK warns on every run that it has nowhere to keep what it discovered.
  saveDiscoveryState(found: OAuthDiscoveryState): void {
    this.#discovery = found;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

const signIn = new SignIn();
const transport = (): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(RELAY, { authProvider: signIn });
let client = new Client({ name: 'my-script', version: '1.0.0' });
const first = transport();
try {
  await client.connect(first);
} catch (error) {
  if (!(error instanceof UnauthorizedError)) throw error;
  const params = await callback;
  if (params.has('error')) throw new Error('the provider refused the sign-in');
  await first.finishAuth(params);
  client = new Client({ name: 'my-script', version: '1.0.0' });
  await client.connect(transport());
}
server.close();
console.log(await client.callTool({ name: 'list_pages', arguments: {} }));
await client.close();
```

An account the relay lists is a member and pairs by code; any other, with invites on, is an invitee and pairs by a one-use invite link, as `pair_page`'s `invite`. A program with nobody to sign in uses an agent token instead ([Join a shared page](22-join-a-shared-page.md#with-an-agent-token)).

## Pair a script in headless Chromium

The widget lives in a closed shadow root, so Playwright's locators and accessibility snapshots never see it. `@tabdock/adapter/testing` reads it through the DevTools protocol instead, as [the CI check](17-check-from-ci.md) does, and clicks with trusted input once a button has held still. Install Playwright and the SDK client beside the adapter, from the release after 0.1.0 once it is on npm or from a clone's tarballs until then ([Copy the CI check](23-copy-the-ci-check.md#install)):

```sh
npm install --save-dev --save-exact @playwright/test@1.56.1 @modelcontextprotocol/client@2.3.1
npx playwright install chromium
```

This program opens a page on this computer that attaches as it loads, such as the one on [Add to your app](03-add-to-your-app.md#add-the-adapter), with `pnpm dev` or `pnpm relay` running in the clone; save it as `pair-script.ts` and run it as `TOKEN_FILE=<owner token file> node pair-script.ts`:

```ts
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium } from '@playwright/test';
import { allowAttach, readPairingCode, widgetText } from '@tabdock/adapter/testing';

const NAME = 'my-script';
// Never print what the file holds, nor the pairing code.
const token = readFileSync(process.env.TOKEN_FILE ?? '', 'utf8').trim();
const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await page.goto('http://127.0.0.1:5500/');
const code = await readPairingCode(cdp);

const client = new Client({ name: NAME, version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const pairing = client.callTool({ name: 'pair_page', arguments: { code } });
// The prompt carries the name the client declared, without its version.
await allowAttach(cdp, { as: 'driver', client: NAME });
console.log(await pairing);
console.log(await widgetText(cdp, 'roster'));
await client.close();
await browser.close();
```

`allowAttach` matches `client` against the name the client gave in `new Client({ name })`, exactly; the widget's roster shows that name with the version after it, here `my-script 1.0.0`. It refuses to choose, clicking nothing, when two waiting requests carry the name, so give each script a name of its own.

## Fill a field

Inputs carry actions too. Click the field's action, select what it holds and type, as a person would; this, in the same program before `browser.close()`, starts a session labelled Period 3 for the form's default 60 minutes:

<!-- fragment -->

```ts
import { clickInWidget } from '@tabdock/adapter/testing';

await clickInWidget(cdp, { action: 'session-open' });
await clickInWidget(cdp, { action: 'session-label' });
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Period 3');
await clickInWidget(cdp, { action: 'session-start' });
console.log(await widgetText(cdp, 'session-countdown'));
```

A button inside a repeated row needs the row as well as the action, such as `{ action: 'proposal-accept', proposalId }` or `{ action: 'revoke', userId }`, and the helper refuses a target that two buttons match.

## The testing helper

`@tabdock/adapter/testing` ships in the adapter's package and takes any DevTools session through a structural `DevToolsSession` type, `{ send(method, params) }`, which Playwright's `CDPSession` and Puppeteer's fit, so Playwright is not a dependency. It never logs, and no error it throws quotes what it read. Every wait takes `{ timeoutMs }`.

| Export              | Call                                                            | What it does                                                                                                                                |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `readPairingCode()` | `readPairingCode(cdp, { timeoutMs })`, 10 s unless set          | Waits for the widget to show a pairing code and returns it; never print it                                                                  |
| `allowAttach()`     | `allowAttach(cdp, { as, client })` or `{ as, requestId }`, 20 s | Clicks Allow as `as`, driver or observer, on the one request from that client name or with that id; returns its id once the prompt has gone |
| `clickInWidget()`   | `clickInWidget(cdp, target, { timeoutMs })`, 5 s                | Clicks the target once it is armed, its centre is in view and a hit test there reaches it, checking again just before the press             |
| `widgetButton()`    | `widgetButton(cdp, target, { timeoutMs })`, 5 s                 | Waits until the target is armed, in view and uncovered at its centre, and returns `{ backendNodeId, x, y }`, where a press would go         |
| `widgetText()`      | `widgetText(cdp, role)`                                         | The text under the node with that role, or null while there is none                                                                         |
| `waitingPrompts()`  | `waitingPrompts(cdp)`                                           | `{ attach: [{ requestId, client }], confirm: [{ callId }] }`, so a walk fails fast on a prompt it cannot see                                |
| `maskCode()`        | `maskCode(code)`                                                | The code with its second half hidden, for narration                                                                                         |
| `WidgetTestError`   | thrown                                                          | What the helper throws: counts, actions and timeouts, never text it read                                                                    |
| `HOST_TAG`          | `'tabdock-dock'`                                                | The widget's element name                                                                                                                   |
| `WIDGET_ACTIONS`    | a list                                                          | Every action a button or input carries                                                                                                      |
| `WIDGET_ROLES`      | a list                                                          | Every role a block or line carries                                                                                                          |

The helper hit-tests the very point it presses, on a scrolled, pinch-zoomed, right-to-left or vertical page and at a fractional device scale too, and presses nothing whose centre is out of view.

Chrome on Android lets an element that fills the screen scroll in the document's place (its implicit root scroller), and the hit test does not count that scroll. Once such an element has scrolled, the helper throws rather than press, or, where it may sit at the very end of a range short enough to leave that first check on the button (its padding counts), checks the press point too. One arrangement still reads like an ordinary scrolled page: a right-to-left page overflowing sideways under such an element scrolled as far. So test on desktop Chromium, as a CI check does, where that behaviour is off.

A target is the action and, inside one box, at most the box's id:

<!-- fragment -->

```ts
interface WidgetTarget {
  action: WidgetAction;
  requestId?: string; // inside one attach prompt
  callId?: string; // inside one consequential prompt
  userId?: string; // inside one roster row
  inviteId?: string; // inside one invite's row
  proposalId?: string; // inside one proposal's row
}
```

[`widget-names.ts`](../../packages/adapter/src/widget-names.ts) lists the actions and roles grouped by the control they belong to: prompts (`approve-driver`, `approve-observer`, `deny`, `confirm-allow`), the roster (`make-driver`, `revoke`, `revoke-all`), the Invite form (`invite-open`, `invite-label`, `invite-kind-agent`, `invite-create`), proposals, sessions (`session-open` to `session-end-yes`), agent tokens and the record (`record-save-json`).

Next: [the guide's index](README.md).
