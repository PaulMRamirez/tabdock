// Entry for the script-tag build (scripts/build.ts). A page adds
//   <script src="tabdock-adapter.js" data-relay="wss://relay.example/page"
//           data-consequential-tools="clear_board"></script>
// and the adapter attaches once the document has parsed, so a WebMCP polyfill
// loaded as a module script is in place first. The handle stays inside: the
// widget is this build's only control surface.

import { attach } from './index.ts';
import { readScriptOptions } from './script-options.ts';

const script = document.currentScript;
if (!(script instanceof HTMLScriptElement)) {
  console.error('[tabdock] load the adapter build with a classic <script> tag');
} else {
  const options = readScriptOptions(script.dataset);
  if (!options.ok) {
    console.error(`[tabdock] ${options.error}`);
  } else {
    const start = (): void => {
      attach({ relay: options.relay, policy: options.policy });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
}
