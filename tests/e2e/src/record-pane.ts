// The client pane of pnpm record:map-demo (record-map-demo.ts): a page the
// recorder serves on loopback beside the map demo, filmed as a video of its
// own and set on the left of the take. It draws only what the recorder hands
// it: the scripted client's own calls and the relay's answers as they
// return, and one caption per step. Nothing here is a chat: the head says a
// script stands in for Claude, and a caption is styled and labelled as one,
// never as words from a model.
//
// The page holds no script. The recorder renders each state into it through
// the DevTools protocol, building nodes with textContent alone, since an
// answer's text is untrusted page content. It is served under a policy that
// loads nothing, answers only its own loopback names, and is never framed.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Page } from '@playwright/test';

/** One call as the pane shows it: what the client sent, then what the relay answered. */
export interface PaneEntry {
  id: number;
  /** The relay's tool the client called: pair_page, call_page_tool, get_page_state. */
  tool: string;
  /** The page's tool, for call_page_tool. */
  pageTool: string | null;
  /** The arguments in a short readable form, the code never among them. */
  args: string;
  status: 'waiting' | 'ok' | 'error';
  /** The first lines of the relay's answer, as it returned them. */
  answer: string[];
  /** One fact the client read out of the answer, such as a state version. */
  note: string | null;
  /** The PNG an image answer carried, as base64, drawn as a thumbnail. */
  png: string | null;
  /** The round trip in milliseconds, once answered. */
  ms: number | null;
}

/** A caption: what a person would ask the client, or what happens at the tab. */
export interface PaneCaption {
  kind: 'ask' | 'tab';
  text: string;
}

export interface PaneState {
  caption: PaneCaption | null;
  entries: PaneEntry[];
}

/** The pane's width and height in CSS pixels: about 38 percent of a 1280 by 720 frame. */
export const PANE_SIZE = { width: 488, height: 720 } as const;

const PANE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: #0d1320; color: #e5e9f0; font: 14px/1.4 system-ui, sans-serif;
  display: flex; flex-direction: column; }
header { flex: none; padding: 14px 18px 12px; background: #172033; border-bottom: 1px solid #2a3550; }
h1 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 700; color: #fff; }
header p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.4; color: #aab4c5; }
/* Room for two lines always, so the calls below never move when a caption changes. */
.caption { flex: none; margin: 12px 14px 4px; padding: 9px 12px 10px; border-radius: 6px;
  background: #fdf3d2; color: #2b2410; border-left: 5px solid #d08a12; min-height: 82px; }
.caption[hidden] { display: block; visibility: hidden; }
.caption .label { display: block; font: 700 11px/1.3 system-ui, sans-serif;
  letter-spacing: 0.08em; text-transform: uppercase; color: #8a5a07; }
.caption .text { display: block; margin-top: 2px; font-size: 17px; line-height: 1.3; }
.caption.ask .text { font-style: italic; }
.log-head { flex: none; margin: 8px 18px 4px; font: 700 11px/1.3 system-ui, sans-serif; letter-spacing: 0.08em;
  text-transform: uppercase; color: #8794aa; }
ol { list-style: none; margin: 0; padding: 0 14px; flex: 1 1 auto; overflow: hidden;
  display: flex; flex-direction: column; gap: 8px;
  mask-image: linear-gradient(to bottom, #000 82%, transparent 100%); }
li { padding: 9px 11px 10px; border-radius: 6px; background: #161f30; border: 1px solid #26324a; }
li:first-child { border-color: #4f7fb8; background: #17243a; }
li:not(:first-child) { opacity: 0.62; }
.head { display: flex; align-items: baseline; gap: 8px; }
.via { font: 12px/1.3 ui-monospace, 'DejaVu Sans Mono', monospace; color: #8fa3c0; }
.tool { font: 700 16px/1.3 ui-monospace, 'DejaVu Sans Mono', monospace; color: #fff; }
.ms { margin-left: auto; font: 12px/1.3 ui-monospace, 'DejaVu Sans Mono', monospace; color: #8fa3c0; }
.args { margin-top: 3px; font: 12.5px/1.4 ui-monospace, 'DejaVu Sans Mono', monospace; color: #c9d4e5;
  overflow-wrap: anywhere; }
.note { margin-top: 5px; display: inline-block; padding: 1px 7px; border-radius: 4px; background: #24486e;
  color: #fff; font: 600 13px/1.5 system-ui, sans-serif; }
canvas { display: block; margin-top: 7px; width: 224px; height: 126px; border-radius: 4px;
  border: 1px solid #3a4a66; background: #0b1020; }
.answer-label { margin-top: 6px; font: 600 10.5px/1.3 system-ui, sans-serif; letter-spacing: 0.06em;
  text-transform: uppercase; color: #7f8ca3; }
pre { margin: 2px 0 0; font: 11.5px/1.4 ui-monospace, 'DejaVu Sans Mono', monospace; color: #b8c7dc;
  white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 4; overflow: hidden; }
li.waiting pre { color: #e7c873; font-style: italic; }
li.error .tool { color: #ff9b9b; }
.empty { color: #7f8ca3; font-style: italic; padding: 4px 4px; }
`;

const PANE_HTML = (styleHash: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'">
<title>MCP client pane</title>
<style>${PANE_CSS}</style>
</head>
<body>
<header>
<h1>MCP client (scripted, standing in for Claude)</h1>
<p>A script on the MCP SDK, not Claude, calls a Tabdock relay on this machine. Each entry is one real call and the start of the relay's real answer, shown as it returns.</p>
</header>
<div class="caption" hidden><span class="label"></span><span class="text"></span></div>
<div class="log-head">Calls, newest first</div>
<ol></ol>
</body>
</html>`;

export interface PaneServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Serves the pane on 127.0.0.1 at a free port: one page, GET and HEAD only,
 * answering only its own loopback names, under a policy that loads nothing
 * and refuses every frame. It holds no script and no data; the recorder
 * renders into it.
 */
export async function servePane(): Promise<PaneServer> {
  const styleHash = createHash('sha256').update(PANE_CSS).digest('base64');
  const html = PANE_HTML(styleHash);
  const server = createServer((request, response) => {
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? String(address.port) : '';
    const own = [`127.0.0.1:${port}`, `localhost:${port}`].includes(
      (request.headers.host ?? '').toLowerCase(),
    );
    const ok =
      own && (request.method === 'GET' || request.method === 'HEAD') && request.url === '/';
    response.writeHead(ok ? 200 : 404, {
      'Content-Type': ok ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : ok ? html : 'Not found');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address to serve on');
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    },
  };
}

/**
 * Draws a state into the pane, newest call first. Nodes are kept by entry id
 * and updated in place, so a thumbnail is decoded once and nothing redraws
 * that did not change; every string goes in as textContent.
 */
export async function renderPane(page: Page, state: PaneState): Promise<void> {
  await page.evaluate((next: PaneState) => {
    const caption = document.querySelector<HTMLElement>('.caption');
    if (caption) {
      if (next.caption === null) {
        caption.hidden = true;
      } else {
        caption.hidden = false;
        caption.className = `caption ${next.caption.kind}`;
        const label = caption.querySelector('.label');
        const text = caption.querySelector('.text');
        if (label) {
          label.textContent =
            next.caption.kind === 'ask'
              ? 'Caption: what a person would ask'
              : 'Caption: at the tab';
        }
        if (text) {
          text.textContent =
            next.caption.kind === 'ask' ? `“${next.caption.text}”` : next.caption.text;
        }
      }
    }

    const list = document.querySelector('ol');
    if (!list) return;
    const make = (tag: string, className: string, parent: Element): HTMLElement => {
      const node = document.createElement(tag);
      node.className = className;
      parent.append(node);
      return node;
    };
    if (next.entries.length === 0) {
      if (list.querySelector('.empty') === null) {
        const empty = make('li', 'empty', list);
        empty.textContent = 'No calls yet.';
      }
      return;
    }
    list.querySelector('.empty')?.remove();

    const ordered: Element[] = [];
    for (const entry of [...next.entries].reverse()) {
      let item = list.querySelector<HTMLElement>(`li[data-entry="${String(entry.id)}"]`);
      if (item === null) {
        item = document.createElement('li');
        item.dataset.entry = String(entry.id);
        const head = make('div', 'head', item);
        if (entry.pageTool !== null) make('span', 'via', head).textContent = entry.tool;
        make('span', 'tool', head).textContent = entry.pageTool ?? entry.tool;
        make('span', 'ms', head);
        make('div', 'args', item).textContent = entry.args;
        make('div', 'answer-label', item).textContent = 'Relay answer, first lines';
        make('pre', '', item);
      }
      item.className = entry.status;
      const ms = item.querySelector('.ms');
      if (ms) ms.textContent = entry.ms === null ? '' : `${String(entry.ms)} ms`;
      const pre = item.querySelector('pre');
      if (pre) {
        pre.textContent =
          entry.status === 'waiting' ? 'waiting for the answer...' : entry.answer.join('\n');
      }
      if (entry.note !== null && item.querySelector('.note') === null) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = entry.note;
        item.querySelector('.args')?.after(note);
      }
      if (entry.png !== null && item.querySelector('canvas') === null) {
        const picture = document.createElement('canvas');
        picture.width = 448;
        picture.height = 252;
        (item.querySelector('.note') ?? item.querySelector('.args'))?.after(picture);
        // The PNG the client received, drawn from its bytes; no URL is loaded.
        const bytes = Uint8Array.from(atob(entry.png), (char) => char.charCodeAt(0));
        void createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((bitmap) => {
          picture.getContext('2d')?.drawImage(bitmap, 0, 0, picture.width, picture.height);
        });
      }
      ordered.push(item);
    }
    list.replaceChildren(...ordered);
  }, state);
}

/** Every piece of text the pane holds, as a guard reads it before a scene. */
export async function paneText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const words = [document.title, document.body.innerText];
    for (const node of document.querySelectorAll('*')) {
      for (const name of node.getAttributeNames()) words.push(node.getAttribute(name) ?? '');
    }
    return words.join('\n');
  });
}
