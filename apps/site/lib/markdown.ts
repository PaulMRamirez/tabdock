// One tour page from Markdown to the body of its HTML page, with marked.
// Mermaid fences become <img> elements naming the SVG the build draws for
// them; links and images are rewritten by links.ts; raw HTML in the Markdown
// is shown as text, never passed through, so the page's markup is marked's
// own and the checks in checks.ts have only that to vouch for.

import { Marked, type Token, type Tokens } from 'marked';
import { type LinkContext, rewriteImage, rewriteLink } from './links.ts';

export interface Diagram {
  /** The file it is drawn to, beside the page in img/, such as 00-1.svg. */
  file: string;
  source: string;
  /** Text for the <img>: the section the diagram sits in. */
  alt: string;
}

export interface RenderedPage {
  title: string;
  body: string;
  diagrams: Diagram[];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A heading's plain text: inline code and emphasis marks dropped, as a reader sees it. */
function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if ('tokens' in token && Array.isArray(token.tokens) && token.type !== 'codespan') {
        return plainText(token.tokens);
      }
      return 'text' in token && typeof token.text === 'string' ? token.text : '';
    })
    .join('');
}

/** GitHub's heading anchors, so a link to #one-call-traced lands as it does on GitHub. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * Renders one page. `stem` names it (00-baseline) and its diagrams'
 * files (00-1.svg, 00-2.svg) by the page's number.
 */
export function renderTourPage(markdown: string, stem: string, links: LinkContext): RenderedPage {
  const prefix = /^(\d+)-/.exec(stem)?.[1] ?? stem;
  const diagrams: Diagram[] = [];
  const diagramOf = new Map<Tokens.Code, Diagram>();
  const anchors = new Map<string, number>();
  let title = '';
  let section = '';

  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        section = plainText(heading.tokens);
        if (heading.depth === 1 && title === '') title = section;
      } else if (token.type === 'code' && (token as Tokens.Code).lang?.trim() === 'mermaid') {
        const code = token as Tokens.Code;
        const diagram: Diagram = {
          file: `${prefix}-${String(diagrams.length + 1)}.svg`,
          source: code.text,
          alt: `Diagram: ${section || title || stem}`,
        };
        diagrams.push(diagram);
        diagramOf.set(code, diagram);
      } else if (token.type === 'link') {
        const link = token as Tokens.Link;
        link.href = rewriteLink(link.href, links);
      } else if (token.type === 'image') {
        const image = token as Tokens.Image;
        image.href = rewriteImage(image.href);
      }
    },
    renderer: {
      code(token) {
        const diagram = diagramOf.get(token);
        if (diagram === undefined) return false;
        // Wide diagrams scroll sideways inside the figure, so a phone can read them.
        return `<figure class="diagram"><img src="img/${escapeHtml(diagram.file)}" alt="${escapeHtml(diagram.alt)}"></figure>\n`;
      },
      html(token) {
        return escapeHtml(token.text);
      },
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const base = slug(plainText(token.tokens)) || 'section';
        const seen = anchors.get(base) ?? 0;
        anchors.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${String(seen)}`;
        return `<h${String(token.depth)} id="${escapeHtml(id)}">${text}</h${String(token.depth)}>\n`;
      },
    },
  });

  const body = marked.parse(markdown, { async: false });
  if (title === '') throw new Error(`docs/tour/${stem}.md has no # title`);
  return { title, body, diagrams };
}
