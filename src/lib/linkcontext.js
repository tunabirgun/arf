// Plain-text views of a note's Markdown for the rail and the link preview: the sentence around a
// [[wikilink]] (backlink context) and a short excerpt of the rendered text. Pure, no DOM.
// Code is skipped the same way graphindex.js skips it, so a [[link]] inside code never counts.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// heading, blockquote, list item (with an optional task box): block syntax at the start of a line
const BLOCK = /^\s*(?:#{1,6}\s+|(?:>\s?)+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)*/;

// inline Markdown -> the text a reader sees. Images vanish; links, wikilinks, citations, code and
// emphasis keep their visible text.
export function stripInline(s) {
  return String(s || '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[([^\]]+?)\]\]/g, (m, raw) => { const bar = raw.indexOf('|'); return (bar < 0 ? raw : raw.slice(bar + 1) || raw.slice(0, bar)).trim(); })
    .replace(/\[@[+!]?([A-Za-z0-9_:.-]+)\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([^*_]*?\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\$([^$\n]+)\$/g, '$1');
}

const squash = (s) => s.replace(/\s+/g, ' ');

// cut to at most n characters on a word boundary, marking the cut with an ellipsis
function cutEnd(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, Math.max(0, n - 1)), sp = head.lastIndexOf(' ');
  return (sp > n * 0.5 ? head.slice(0, sp) : head).replace(/[\s,;:]+$/, '') + '…';
}
function cutStart(s, n) {
  if (s.length <= n) return s;
  const tail = s.slice(s.length - Math.max(0, n - 1)), sp = tail.indexOf(' ');
  return '…' + (sp >= 0 && sp < n * 0.5 ? tail.slice(sp + 1) : tail);
}

// The sentence around the first [[title]] / [[title|alias]] link in body, outside code.
// -> { before, match, after } (plain text; match is the link as displayed), or null.
export function linkContext(body, title, { max = 140 } = {}) {
  const want = String(title == null ? '' : title).trim().toLowerCase();
  if (!want || !body) return null;
  let fence = null;
  for (const line of String(body).split('\n')) {
    const f = FENCE.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; continue; }
    if (fence || line.indexOf('[[') < 0) continue;
    const re = /`[^`]*`|\[\[([^\]]+?)\]\]/g; let m;
    while ((m = re.exec(line))) {
      if (m[1] === undefined) continue;   // an inline code span
      const raw = m[1].trim(), bar = raw.indexOf('|');
      if ((bar < 0 ? raw : raw.slice(0, bar)).trim().toLowerCase() !== want) continue;
      const start = m.index, end = start + m[0].length;
      // sentence bounds inside the line, never reaching into the block prefix (heading, list, quote)
      const lead = BLOCK.exec(line)[0].length;
      let s0 = lead;
      const stops = /[.!?](?=\s)/g; let st;
      while ((st = stops.exec(line)) && st.index < start) if (st.index + 1 > s0) s0 = st.index + 1;
      const tail = /[.!?](?=\s|$)/g; tail.lastIndex = end;
      const t = tail.exec(line), s1 = t ? t.index + 1 : line.length;
      const match = squash(stripInline(m[0])).trim();
      let before = squash(stripInline(line.slice(s0, start))).replace(/^\s+/, '');
      let after = squash(stripInline(line.slice(end, s1))).replace(/\s+$/, '');
      const room = Math.max(0, max - match.length);
      if (before.length + after.length > room) {
        const b = Math.min(before.length, Math.max(Math.floor(room * 0.4), room - after.length));
        before = cutStart(before, b);
        after = cutEnd(after, Math.max(0, room - before.length));
      }
      return { before, match, after };
    }
  }
  return null;
}

// The first `max` characters of a note's visible text: block syntax, images and inline marks removed,
// code content kept, lines joined.
export function previewText(body, max = 280) {
  const out = []; let fence = null, len = 0;
  for (const line of String(body || '').split('\n')) {
    const f = FENCE.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; continue; }
    let t;
    if (fence) t = line;
    else {
      if (/^\s*\$\$\s*$/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?[\s:-]*-[\s:|-]*$/.test(line)) continue;
      t = stripInline(line.replace(BLOCK, '')).replace(/\|/g, ' ');
    }
    t = squash(t).trim();
    if (!t) continue;
    out.push(t); len += t.length + 1;
    if (len > max * 2) break;
  }
  return cutEnd(out.join(' '), max);
}
