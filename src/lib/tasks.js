// Task-checkbox bookkeeping for the read view. The i-th rendered input[data-task] must map to the i-th
// task in the source, so the tasks come from marked's own token tree (the same lexer and extensions
// renderMarkdown uses): fenced and indented code, blockquoted lists, tilde fences, math blocks and the
// like follow marked's rules instead of a hand-written line regex that drifts from them. Which rendered
// boxes are those tasks, and which are raw HTML, is read off the rendered note itself (renderTaskProbe):
// a checkbox in a comment, <script>, <style>, <textarea>, <template>... never reaches the read view, and
// an unclosed one swallows the tasks after it, which no per-token count can follow.
import { lexMarkdown, renderTaskProbe } from './markdown.js';

const nl = (s) => { let n = 0; for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++; return n; };
// source lines a block token spans. marked adds a '\n' to the raw of a merged text/paragraph token twice
// (once from the blank-line token, once from the merge), so for those the span is the newlines inside
// `text` plus the newlines trailing `raw`.
const span = (t) => ((t.type === 'text' || t.type === 'paragraph') && typeof t.text === 'string' ? nl(t.text) + /\n*$/.exec(t.raw)[0].length : nl(t.raw || ''));
// renderMarkdown tags every <input type=checkbox> in the HTML, including hand-written ones (the no-DOM count)
const RAW_CHECKBOX = (html) => (html.match(/<input\b([^>]*)>/g) || []).filter((m) => /type=["']?checkbox/i.test(m)).length;

// One entry per rendered data-task checkbox, in DOM order: { line, nth, checked } for a task item (its source
// line, and which task on that line when `- [ ] - [ ] x` puts two there), or null for a raw-HTML checkbox that
// has no source line to toggle.
export function taskSlots(body) {
  const src = body == null ? '' : String(body);
  const slots = [], tasks = [], perLine = new Map();
  let rawHtml = false;
  const walk = (tokens, line) => {
    for (const t of tokens) {
      if (t.type === 'list') {
        let l = line;
        for (const it of t.items) {
          if (it.task) { const nth = perLine.get(l) || 0, s = { line: l, nth, checked: !!it.checked }; perLine.set(l, nth + 1); slots.push(s); tasks.push(s); }
          walk(it.tokens || [], l);   // an item's text lines map 1:1 onto its raw source lines
          l += nl(it.raw);
        }
      } else if (t.type === 'html') { rawHtml = true; for (let k = RAW_CHECKBOX(t.text || ''); k > 0; k--) slots.push(null); }
      else if (t.type === 'table') { [t.header, ...t.rows].forEach((row) => row.forEach((c) => walk(c.tokens || [], line))); }
      else if (t.tokens) walk(t.tokens, line);
      line += span(t);
    }
  };
  walk(lexMarkdown(src), 0);
  // Without raw HTML (block or inline) every rendered box is a task, in token order, so the token walk is
  // exact and the render is skipped. Otherwise: the rendered boxes in DOM order, parsed in an inert document
  // (no image loads); without a DOM, or if the probe's task count disagrees with the walk, the walk stands.
  if (!rawHtml || typeof document === 'undefined') return slots;
  try {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const { html, count } = renderTaskProbe(src, nonce);
    if (count !== tasks.length) return slots;
    const div = document.implementation.createHTMLDocument('').createElement('div');
    div.innerHTML = html;
    const pre = nonce + ':';
    return [...div.querySelectorAll('input[data-task]')].map((el) => {
      const t = el.getAttribute('data-tslot');
      return t && t.startsWith(pre) ? tasks[+t.slice(pre.length)] || null : null;
    });
  } catch (e) { return slots; }
}

// offsets of the [ ]/[x] characters of every task marker on one source line: any container prefix
// (indent, '>'), then one or more bullets, a '[ ] ' marker directly after a bullet counting as a task
function markerOffsets(text) {
  const out = []; let p = /^[ \t>]*/.exec(text)[0].length;
  const bullet = /(?:[-*+]|\d{1,9}[.)])[ \t]+/y, task = /\[[ xX]\] +/y;
  for (;;) {
    bullet.lastIndex = p; const b = bullet.exec(text); if (!b) break;
    p += b[0].length;
    task.lastIndex = p; const m = task.exec(text);
    if (m) { out.push(p + 1); p += m[0].length; }
  }
  return out;
}

// Flip the i-th rendered task checkbox in `body`. Returns the new body, or null when i is out of range or
// that checkbox has no task line (raw HTML). Line endings and every other character are preserved.
// The line comes from marked's token positions; every edit is then checked by re-lexing (exactly checkbox i
// must change state). marked's raw text is unreliable inside blockquotes with lazy continuation lines, so
// if the computed line fails that check, every marker position is tried, nearest first, under the same check.
export function toggleTaskAt(body, i) {
  if (!Number.isInteger(i) || i < 0) return null;
  const src = body == null ? '' : String(body);
  const was = taskSlots(src), slot = was[i]; if (!slot) return null;
  const parts = src.split(/(\r\n|\r|\n)/);   // [line, eol, line, eol, ...]; marked also treats a lone \r as a newline
  const attempt = (ln, at) => {
    const text = parts[ln * 2]; if (text === undefined || at === undefined) return null;
    const next = parts.slice(); next[ln * 2] = text.slice(0, at) + (text[at] === ' ' ? 'x' : ' ') + text.slice(at + 1);
    const out = next.join(''), now = taskSlots(out);
    const ok = now.length === was.length && was.every((w, k) => (w === null ? now[k] === null : now[k] !== null && now[k].checked === (k === i ? !w.checked : w.checked)));
    return ok ? out : null;
  };
  const direct = attempt(slot.line, markerOffsets(parts[slot.line * 2] ?? '')[slot.nth]);
  if (direct !== null) return direct;
  const cands = [];
  for (let ln = 0; ln * 2 < parts.length; ln++) for (const at of markerOffsets(parts[ln * 2])) cands.push([ln, at]);
  cands.sort((a, b) => Math.abs(a[0] - slot.line) - Math.abs(b[0] - slot.line));
  for (const [ln, at] of cands.slice(0, 200)) { const out = attempt(ln, at); if (out !== null) return out; }
  return null;
}
