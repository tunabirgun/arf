// Render a note's Markdown body to HTML for the read view.
// marked for structure; KaTeX for math; custom inline tokens for [[wikilinks]] and #tags.
import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';

let resolveTitle = () => null; // (lowercaseTitle) -> note | null
export function setLinkResolver(fn) { resolveTitle = fn; }
let resolveCite = () => null; // (citekey) -> reference | null
export function setCiteResolver(fn) { resolveCite = fn; }

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function math(tex, display) {
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' }); }
  catch (e) { return '<code>' + esc(tex) + '</code>'; }
}

const mathBlock = {
  name: 'mathBlock', level: 'block',
  start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
  tokenizer(src) { const m = /^\$\$([\s\S]+?)\$\$/.exec(src); if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() }; },
  renderer(t) { return '<div class="math-display">' + math(t.text, true) + '</div>'; },
};
const mathInline = {
  name: 'mathInline', level: 'inline',
  start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
  // require non-space right after the opening $ and no digit right after the closing $,
  // so prose like "it costs $5 and $10 total" is not mistaken for math
  tokenizer(src) { const m = /^\$(?!\s)([^$\n]*?[^\s$])\$(?!\d)/.exec(src); if (m) return { type: 'mathInline', raw: m[0], text: m[1] }; },
  renderer(t) { return math(t.text, false); },
};
const wikilink = {
  name: 'wikilink', level: 'inline',
  start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
  tokenizer(src) { const m = /^\[\[([^\]]+?)\]\]/.exec(src); if (m) return { type: 'wikilink', raw: m[0], title: m[1].trim() }; },
  renderer(t) {
    const n = resolveTitle(t.title.toLowerCase());
    if (n) return '<a class="wl" data-nav="' + n.id + '" href="#">' + esc(t.title) + '</a>';
    return '<span class="wl dangling" title="unresolved link">' + esc(t.title) + '</span>';
  },
};
const tag = {
  name: 'tag', level: 'inline',
  start(src) { const m = /(^|\s)#[a-z0-9]/i.exec(src); return m ? m.index : undefined; },
  tokenizer(src) { const m = /^#([a-z0-9][a-z0-9/-]*)/i.exec(src); if (m) return { type: 'tag', raw: m[0], tag: m[1] }; },
  renderer(t) { return '<a class="ht" data-tag="' + t.tag.toLowerCase() + '" href="#">#' + esc(t.tag) + '</a>'; },
};
const cite = {
  name: 'cite', level: 'inline',
  start(src) { const i = src.indexOf('[@'); return i < 0 ? undefined : i; },
  tokenizer(src) { const m = /^\[@([A-Za-z0-9_:.-]+)\]/.exec(src); if (m) return { type: 'cite', raw: m[0], key: m[1] }; },
  renderer(t) {
    const r = resolveCite(t.key);
    if (r) {
      const who = r.authors && r.authors[0] ? r.authors[0].f : t.key;
      const label = who + (r.year ? ' ' + r.year : '');
      return '<a class="cite" data-cite="' + t.key + '" href="#" title="' + esc(r.title || '') + '">' + esc(label) + '</a>';
    }
    return '<span class="cite dangling" title="unknown reference — add it in the Library">@' + esc(t.key) + '</span>';
  },
};

marked.use({ gfm: true, breaks: false, extensions: [mathBlock, mathInline, wikilink, tag, cite] });

export function renderMarkdown(md) {
  try {
    // sanitize: a note may come from an external .md file in the vault, so strip
    // scripts/handlers while keeping wikilink data-attrs and KaTeX's spans/styles
    return DOMPurify.sanitize(marked.parse(md || ''), { ADD_ATTR: ['data-nav', 'data-tag', 'data-cite'] });
  } catch (e) { return '<p>' + esc(md || '') + '</p>'; }
}
