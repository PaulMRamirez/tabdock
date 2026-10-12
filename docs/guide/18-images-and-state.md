# Images and page state

A page can show a client what it shows the room in two ways: a tool that returns a picture of its own canvas, and a small JSON object it publishes whenever its view changes, which any attached client reads or waits on without running a tool. Both are page content, so both reach a client only behind the relay's untrusted label. The settings are on [Settings for rooms, images and state](14-settings-for-rooms.md) and the fixed numbers on [Limits for rooms, images and state](15-limits-for-rooms.md); [Map and globe pages](16-map-pages.md) gives the map profile's `capture_view` and published state as worked examples.

From a clone, `pnpm dev` serves the demo board, whose `capture_board` returns a picture and which publishes its state on each change ([Quick start](02-quick-start.md)).

## Return an image

Name the tool in the policy's `imageTools` (`data-image-tools` on a script tag, a comma list), and have its handler return one envelope: `{ image: { mimeType, data }, text }`, where `data` is a data URL or bare base64, `mimeType` is needed only with bare base64, and `text` is optional; past 1,900 characters the adapter cuts it with a marker, so the relay's 2,000 holds. Exactly one still PNG, JPEG or WebP passes, at most 8,192 pixels a side and the relay's cap in decoded bytes: 65,536 by default (`TABDOCK_MAX_IMAGE_BYTES`, at most 524,288, 0 for none). The adapter reads the cap from the relay's welcome as `dock.state.maxImageBytes`, and refuses an image a relay that names no cap would drop.

Nobody re-encodes or shrinks an image for you, so the page fits its own: lower the quality, then halve the width, until the encoding fits. Draw only the page's own canvas, never the tab, whose widget shows the pairing code and its QR code.

```ts
import { attach } from '@tabdock/adapter';

const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { imageTools: ['capture_board'] },
});

/** The board as a WebP data URL within the relay's cap; throws, in words a model can act on, when none fits. */
function capture(board: HTMLCanvasElement): string {
  // Null until the relay's welcome names its cap, and 0 for a relay that takes no images.
  const cap = dock.state.maxImageBytes;
  if (cap === null) throw new Error('not linked to a relay yet; try again in a moment');
  const copy = document.createElement('canvas');
  const context = copy.getContext('2d');
  if (cap === 0 || context === null) throw new Error('this relay takes no images');
  for (let width = Math.min(board.width, 1600); width >= 128; width = Math.floor(width / 2)) {
    copy.width = width;
    copy.height = Math.max(1, Math.round((board.height * width) / board.width));
    context.drawImage(board, 0, 0, copy.width, copy.height);
    for (const quality of [0.8, 0.6, 0.45]) {
      const url = copy.toDataURL('image/webp', quality);
      // A browser that cannot encode WebP answers PNG, and an empty canvas "data:,".
      if (!url.startsWith('data:image/webp;base64,')) throw new Error('no WebP here; ask for PNG');
      if (((url.length - url.indexOf(',') - 1) / 4) * 3 <= cap) return url;
    }
  }
  throw new Error(`the board does not fit in ${String(cap)} bytes`);
}

const board = document.querySelector('canvas');
await document.modelContext?.registerTool({
  name: 'capture_board',
  title: 'Capture board',
  description: 'Return a picture of the board as the room sees it.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  execute: async () => {
    if (board === null) throw new Error('the board is not drawn yet');
    return { image: { data: capture(board) }, text: 'The board as projected' };
  },
});
```

The `document.modelContext` declaration is the one in [Add to your app](03-add-to-your-app.md#a-webmcp-runtime). This board's tool takes no arguments and answers WebP; a map page's `capture_view` follows [the profile](16-map-pages.md#capture_view) instead, PNG unless asked `format: 'jpeg'`, and [the CI check](17-check-from-ci.md) asks it for PNG.

A WebGL canvas clears its drawing buffer once a frame is shown, so capture in the same task as a render, or create the context with `preserveDrawingBuffer: true`. A canvas that drew a cross-origin image without CORS refuses `toDataURL` with a `SecurityError`, so serve map tiles with CORS and load them with the `crossorigin` attribute. Draw a stored photo through a canvas too, rather than passing its file on: that sizes it, and leaves its metadata, a camera's location among it, behind.

A declared tool that returns words sends them as text, and every other tool's result stays text whatever it holds, an envelope included. Image calls start on the page one at a time, 250 ms apart, with at most 8 waiting, so a room asking for pictures cannot keep the projected tab drawing; the gate comes after any consequential prompt, so an image call waits its turn only once allowed, and runs after it only if its tool is still the kind it was, read or write. The activity list shows each image's type and size, and the relay's audit line its type, size and SHA-256, never the image.

## Share what the page shows

`dock.publishState(value)` shares a JSON object, or null for nothing, with everyone attached, invited people included, as the widget's state line says. Publish on discrete changes, such as a new view or stop, not every frame: the adapter sends at most two values a second, the latest of a burst last, never resends an equal value, and holds the page's state while it is paused, sending null. It never throws; it returns `{ ok: false, reason }` for a value over 16,384 bytes as canonical JSON (`too_large`) or one that is no object (`invalid`), and clears what the relay holds.

```ts
import { attach } from '@tabdock/adapter';

const dock = attach({ relay: 'ws://127.0.0.1:8787/page' });

function onViewChanged(view: { lat: number; lon: number; widthM: number }): void {
  const result = dock.publishState({ view, publishedBy: 'map' });
  if (!result.ok) console.warn('page state not shared:', result.reason);
}
onViewChanged({ lat: 0, lon: 23.47, widthM: 120_000 });
```

A script-tag page, which keeps the handle to itself, publishes by dispatching a `tabdock:state` event on `document` with the value as its `detail`, as in `document.dispatchEvent(new CustomEvent('tabdock:state', { detail: { stop: 3 } }))`. Any script on the page can dispatch that event, which is the page's own word as every tool result is: Tabdock assumes the page is trusted ([Security](10-security.md)).

Reading state runs no page tool, adds nothing to the activity list or the session record, and never moves an attachment's idle expiry. A read while the page is asleep answers `page_asleep`, and once it is gone `page_gone`.

## Follow a page in a loop

`get_page_state` returns `version`, `publishedAt`, `heardAt` and `value`. `wait_for_page_state` takes `after`, the last version you saw, and answers as soon as the version differs from it, at once if it already does, or after `timeoutMs` (25 s unless set, at most 40 s) with `changed: false`. A client that loops, waiting from the version each answer gives, follows the page without polling it; a jump of more than one means it missed changes, and a value read as null at a raised version means the page shares nothing just now.

Each user holds two waits at once across pages and both waiting tools, and a third answers `rate_limited` at once. So does a wait past the page's own limit: as many as its people and watching seats together, and for its invitees two fewer. A wait ends at once on a revoke, a detach, an expiry or the page's sleep.

## Which clients show images

Claude Code shows a PNG, JPEG or WebP result to its model inline, scaled or compressed to fit, and keeps the original in a file. Its docs say image data counts against `MAX_MCP_OUTPUT_TOKENS`, 25,000 by default, but not how; measured under that default, Claude Code 2.1.296 handed its model PNGs of 64, 128 and 256 KiB unchanged and one of 512 KiB re-encoded as a small JPEG (`docs/notes/verified.md`). An image travels as base64, a third larger than its bytes, so before raising `TABDOCK_MAX_IMAGE_BYTES` past 256 KiB, check what your own client hands its model.

Claude on the web, desktop and phone lists image results as supported, but whether its model sees the picture, and whether an image counts toward its limit of about 150,000 characters a result, waits on the owner's run. Any other MCP client receives an image content block after the label's text block. Reading state needs no image support.

## When it goes wrong

**The label, then `tabdock refused this tool's image: <reason>`**, is the relay's `tool_error`: the page did not name the tool in `imageTools`, the relay takes no images, or the image was not PNG, JPEG or WebP, not canonical base64, over the cap, not what its first bytes say, past 8,192 pixels a side or 16,777,216 in all, or animated: only one still image passes, so an animated PNG or WebP gets "the image is animated; only a still image passes". The page's adapter refuses the same before sending, with the reason alone under the label. A `page_busy` from an image tool can also mean 8 image calls already wait on the page; retry shortly.

**The widget says "Page state not shared".** The value was over 16,384 bytes or not a JSON object; publish a smaller object. "This relay does not take page state" means a 0.1.0 relay, whose welcome names no `maxStateBytes`. A relay past `TABDOCK_MAX_STATE_BYTES` withholds new values without telling the page, logging `page state withheld`: readers see null at a raised version until the page publishes a different value, pauses and resumes, or reconnects, so its operator raises the setting.

A page that skips the adapter and floods state frames is closed: past 40 frames a socket or 200 an address in 10 s with 1008, and for a value over 16,384 bytes with 1009.

Next: [Lessons and reviews](19-lessons-and-reviews.md).
