// Render a note's Markdown body to HTML for the read view.
// marked for structure; KaTeX for math; custom inline tokens for [[wikilinks]] and #tags.
import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';

let resolveTitle = () => null; // (lowercaseTitle) -> note | null
export function setLinkResolver(fn) { resolveTitle = fn; }
let resolveCite = () => null; // (citekey) -> reference | null
export function setCiteResolver(fn) { resolveCite = fn; }

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
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
  // support the standard alias form [[Target|Display]] — resolve on Target, show Display
  tokenizer(src) {
    const m = /^\[\[([^\]]+?)\]\]/.exec(src); if (!m) return;
    const raw = m[1].trim(), bar = raw.indexOf('|');
    const title = (bar < 0 ? raw : raw.slice(0, bar)).trim();
    const display = (bar < 0 ? raw : raw.slice(bar + 1).trim()) || title;
    return { type: 'wikilink', raw: m[0], title, display };
  },
  renderer(t) {
    const n = resolveTitle(t.title.toLowerCase());
    if (n) return '<a class="wl" data-nav="' + n.id + '" href="#">' + esc(t.display) + '</a>';
    // dangling → a create affordance: clicking it makes the note with this title
    return '<a class="wl dangling" data-newlink="' + esc(t.title) + '" href="#" title="Create note “' + esc(t.title) + '”">' + esc(t.display) + '</a>';
  },
};
const tag = {
  name: 'tag', level: 'inline',
  start(src) { const m = /(^|\s)#[\p{L}\p{N}]/u.exec(src); return m ? m.index : undefined; },
  tokenizer(src, tokens) {
    // don't tag a mid-word '#' (C#, A#m7, x#y): require a left boundary, matching start()
    const p = tokens && tokens[tokens.length - 1];
    if (p && p.type === 'text' && /[\p{L}\p{N}/]$/u.test(p.raw)) return;
    // \p{L}: allow Unicode letters in tags (#düşünce, #proteine), not just ASCII
    const m = /^#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/u.exec(src); if (m) return { type: 'tag', raw: m[0], tag: m[1] };
  },
  renderer(t) { return '<a class="ht" data-tag="' + t.tag.toLowerCase() + '" href="#">#' + esc(t.tag) + '</a>'; },
};
const cite = {
  name: 'cite', level: 'inline',
  start(src) { const i = src.indexOf('[@'); return i < 0 ? undefined : i; },
  // optional mode flag ('+' and '!' aren't valid in a citekey, so no ambiguity):
  //   [@key]  → both (in-text citation + reference-list entry)   [default]
  //   [@!key] → in-text only (cite inline, excluded from the reference list)
  //   [@+key] → reference-list only, a la \nocite (no in-text marker, listed at the end)
  tokenizer(src) { const m = /^\[@([+!]?)([A-Za-z0-9_:.-]+)\]/.exec(src); if (m) return { type: 'cite', raw: m[0], mode: m[1], key: m[2] }; },
  renderer(t) {
    if (t.mode === '+') return '';   // reference-only: no in-text marker
    const r = resolveCite(t.key);
    if (r) {
      const who = r.authors && r.authors[0] ? r.authors[0].f : t.key;
      // _suffix disambiguates same-author/same-year works: Guth 1981a, Guth 1981b
      const label = who + (r.year ? ' ' + r.year + (r._suffix || '') : '');
      return '<a class="cite" data-cite="' + t.key + '" href="#" title="' + esc(r.title || '') + '">' + esc(label) + '</a>';
    }
    return '<span class="cite dangling" title="unknown reference — add it in the Library">@' + esc(t.key) + '</span>';
  },
};

marked.use({ gfm: true, breaks: false, extensions: [mathBlock, mathInline, wikilink, tag, cite] });

export function renderMarkdown(md) {
  try {
    let html = marked.parse(md || '');
    // make GFM task checkboxes interactive: drop `disabled` and tag them so the read view
    // can toggle the matching `- [ ]` line in the source when one is clicked
    html = html.replace(/<input\b([^>]*)>/g, (m, attrs) => /type=["']?checkbox/i.test(attrs)
      ? '<input' + attrs.replace(/\s*disabled(=(["'])[^"']*\2|=[^\s>]+)?/gi, '') + ' data-task>' : m);
    // sanitize: a note may come from an external .md file in the vault, so strip
    // scripts/handlers while keeping wikilink data-attrs and KaTeX's spans/styles
    return DOMPurify.sanitize(html, { ADD_ATTR: ['data-nav', 'data-tag', 'data-cite', 'data-task', 'data-newlink'] });
  } catch (e) { return '<p>' + esc(md || '') + '</p>'; }
}
