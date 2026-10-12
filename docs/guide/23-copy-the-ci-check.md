# Copy the CI check

This page copies the check on [Check a page from CI](17-check-from-ci.md) into another repository: the files, the install before and after the release, the four things to change and the workflow job. Your page must first meet [what the check needs](17-check-from-ci.md#what-the-check-needs).

## Install

`@tabdock/adapter/testing` and the state tools the walk calls arrive in the release after 0.1.0. Until it is on npm, `pnpm release:pack` in a clone of this repository writes three tarballs to `dist/packages`: the protocol, the adapter and the relay. They carry the version in the clone's package files, 0.1.0, but are built from whatever the clone has checked out, so a clone of a branch carrying the helper packs it. Copy the three into a folder of your repository, such as `vendor/`, and install them from there, so the `file:` paths npm writes into `package.json` and the lockfile resolve on a runner too. Start each path with `./`, or npm reads `vendor/<file>` as a GitHub repository:

```sh
npm install --save-exact ./vendor/tabdock-protocol-0.1.0.tgz ./vendor/tabdock-adapter-0.1.0.tgz
npm install --save-dev --save-exact ./vendor/tabdock-relay-0.1.0.tgz @playwright/test@1.56.1 @modelcontextprotocol/client@2.3.1 zod@4.6.5
```

The adapter and the protocol stay runtime dependencies, as [Add to your app](03-add-to-your-app.md#add-the-adapter) installs them, and the rest are for the check alone. Commit the tarballs with the lockfile; a pack from a newer clone replaces all three together. Once the release after 0.1.0 is on npm, install it by its version instead:

```sh
npm install --save-exact @tabdock/adapter@<version>
npm install --save-dev --save-exact @tabdock/relay@<version> @playwright/test@1.56.1 @modelcontextprotocol/client@2.3.1 zod@4.6.5
```

## Copy the files

Copy `tests/ci-check/playwright.config.ts` and that directory's `src/` and `specs/` into `tests/ci-check` in your repository. Leave out the rest, which belongs to this repository's workspace: its `package.json` names the adapter as `workspace:*`, its `tsconfig.json` extends this repository's base settings, and `test/` holds the walker's own tests, which need vitest. Everything installs at your repository's root, as above, and Playwright compiles the TypeScript itself; to typecheck the copy, give it a `tsconfig.json` of your own with strict settings, the DOM library and Node's types. Leave out `specs/advisory.spec.ts` and `src/advisory.ts` too unless you want the advisory walk.

## Change four things

**1. `connectPage()` in `src/tabdock.ts`**, how your page links to the relay. The canvas map page links when its own script asks, never from its URL, so the example calls that script:

```ts
import type { Page } from '@playwright/test';

/** Links the page to the relay through the page's own script, never its URL. */
export async function connectPage(page: Page, relayPageUrl: string): Promise<void> {
  const linked = await page.evaluate((relay) => {
    const hook = (window as { __tabdockMapPage?: { connect(relayUrl: string): boolean } })
      .__tabdockMapPage;
    return hook?.connect(relay) ?? false;
  }, relayPageUrl);
  if (!linked) throw new Error('the page did not link to the relay');
}
```

A page that attaches as it loads, as on [Add to your app](03-add-to-your-app.md#register-tools), needs either a test-only hook like that one or a test build that names the relay, never a relay read from its own URL. With a test build, `connectPage()` has nothing to do but check that the build dials the relay the check started; the fixture then waits up to 10 s for the widget's pairing code:

```ts
import type { Page } from '@playwright/test';

/** The test build attaches as it loads, to the relay it was built with. */
const BUILT_FOR = 'ws://127.0.0.1:8787/page';

export async function connectPage(_page: Page, relayPageUrl: string): Promise<void> {
  if (relayPageUrl !== BUILT_FOR) {
    throw new Error(`this test build dials ${BUILT_FOR}; set TABDOCK_PORT to match`);
  }
}
```

Such a build ties the check to the port it names, so two runners on one machine need two builds, each with its own `TABDOCK_PORT`.

**2. `CI_CHECK_PAGE_COMMAND` and `CI_CHECK_PAGE_URL`**, the command that serves your page and its http address on 127.0.0.1 or localhost. Both are required, and with the URL unset or empty the run stops at once. Playwright runs the command in `tests/ci-check`, the config's folder, where npm finds your root `package.json` because the copy has none, so `npm run serve -- --port 5180` runs your root's `serve` script from the root.

**3. `CI_CHECK_RELAY_COMMAND`**, which is `npx --no-install tabdock-relay` unless set, and finds the relay installed at the root.

**4. `REQUIRE_TOOLS` in `specs/walk.spec.ts`**, the clock, capture and observation tools your page registers.

## The workflow

```yaml
name: ci-check
on: [push, pull_request]
permissions:
  contents: read
jobs:
  ci-check:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<commit SHA> # pin by SHA
        with:
          persist-credentials: false
      - uses: actions/setup-node@<commit SHA> # pin by SHA
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build # if your page is bundled, before the check serves it
      - run: npx playwright install --with-deps chromium
      - name: A fresh TABDOCK_HOME under the runner's temporary directory
        run: echo "TABDOCK_HOME=$RUNNER_TEMP/tabdock-ci-check" >> "$GITHUB_ENV"
      - run: npx playwright test --config tests/ci-check/playwright.config.ts --project chromium
        env:
          CI_CHECK_PAGE_COMMAND: npm run serve -- --port 5180
          CI_CHECK_PAGE_URL: http://127.0.0.1:5180/
      - name: Verify the audit chain
        run: npx tabdock-relay audit --verify
      - name: Delete TABDOCK_HOME
        if: always()
        run: rm -rf -- "${TABDOCK_HOME:?}"
```

In a workflow file that already has jobs, add the `ci-check` job under its `jobs:`.

`TABDOCK_HOME` holds the owner token and the audit log. It must be a fresh absolute directory outside every repository, whose every parent only the runner account or root can write, and never under `/tmp`, which local mode refuses. A job's `env` cannot read the runner context, so a step writes it to `$GITHUB_ENV`, where `audit --verify` finds the log too, and the last step deletes it whatever happened. Never cache or upload it; to keep a record, keep the output of `npx tabdock-relay audit --json`, which holds no token, code or argument. Set no other relay setting: local mode's defaults are what make the check safe.

On a self-hosted runner, follow the same steps under its own `RUNNER_TEMP`, with one runner account per machine, since local mode trusts every account on it. Give each runner on one machine its own `TABDOCK_PORT`. Playwright drives Chromium over a pipe, so no other process gets a DevTools port to click Allow with; never add `--remote-debugging-port` on a shared machine.

Next: [Scripts and the widget](24-scripts-and-the-widget.md).
