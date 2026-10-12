// Entry for the script-tag build (scripts/build.ts). A page adds
//   <script src="tabdock-adapter.js" data-relay="wss://relay.example/page"
//           data-consequential-tools="clear_board"></script>
// and the adapter attaches once the document has parsed, so a WebMCP polyfill
// loaded as a module script is in place first. The handle stays inside: the
// widget is this build's only control surface.
//
// Such a page keeps no handle to publish its state with, so this build alone
// listens on document for a `tabdock:state` CustomEvent and publishes its
// detail (ADR 0040). Publishing is page content, never an operator control,
// and any script on the page can already register tools, so the event grants
// nothing new (the trusted-page rule, docs/threat-model.md B5). The event's
// detail getter and addEventListener are taken at load, so a later script
// that replaces either is never handed the values.

import { STATE_EVENT } from './core.ts';
import { attachPage } from './page.ts';
import { readScriptOptions } from './script-options.ts';
import { apply, taken } from './taken.ts';

const detailOf = taken(CustomEvent.prototype, 'detail', 'get');
const listen = taken(EventTarget.prototype, 'addEventListener', 'value');

const script = document.currentScript;
if (!(script instanceof HTMLScriptElement)) {
  console.error('[tabdock] load the adapter build with a classic <script> tag');
} else {
  const options = readScriptOptions(script.dataset);
  if (!options.ok) {
    console.error(`[tabdock] ${options.error}`);
  } else {
    const start = (): void => {
      try {
        // Advice such as the hint notice names data attributes, not attach()'s options.
        const dock = attachPage({ relay: options.relay, policy: options.policy }, 'script-tag');
        apply(listen, document, [
          STATE_EVENT,
          (event: Event) => {
            let detail: unknown;
            try {
              detail = apply(detailOf, event, []);
            } catch {
              // Not a CustomEvent, so it carries no value to publish.
              return;
            }
            dock.publishState(detail);
          },
        ]);
      } catch (error) {
        // One line, never a stack: attach()'s TypeErrors name what is wrong, never a value
        // (ADR 0032), and anything else is not this tag's to describe.
        console.error(
          `[tabdock] ${error instanceof TypeError ? error.message : 'the adapter could not attach'}`,
        );
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
}
