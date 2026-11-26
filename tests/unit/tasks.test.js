// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../../src/lib/markdown.js';
import { taskSlots, toggleTaskAt } from '../../src/lib/tasks.js';

const boxesOf = (body) => { const d = document.createElement('div'); d.innerHTML = renderMarkdown(body); return [...d.querySelectorAll('input[data-task]')]; };
const states = (body) => boxesOf(body).map((b) => b.checked);

describe('toggleTaskAt', () => {
  it('toggles bullets, ordered items and nested tasks by rendered index', () => {
    const body = '- [ ] a\n  - [x] b\n1. [ ] c\n2) [X] d\n* [ ] e';
    expect(states(body)).toEqual([false, true, false, true, false]);
    expect(toggleTaskAt(body, 0)).toBe('- [x] a\n  - [x] b\n1. [ ] c\n2) [X] d\n* [ ] e');
    expect(toggleTaskAt(body, 1)).toBe('- [ ] a\n  - [ ] b\n1. [ ] c\n2) [X] d\n* [ ] e');
    expect(toggleTaskAt(body, 3)).toBe('- [ ] a\n  - [x] b\n1. [ ] c\n2) [ ] d\n* [ ] e');
  });
  it('ignores task-like lines inside fenced code (the F3 bug) so the index follows the rendered checkboxes', () => {
    const body = 'Plan\n\n```\n- [ ] inside fence\n```\n\n- [ ] real one\n- [ ] real two\n\n    - [ ] nested\n';
    expect(taskSlots(body).length).toBe(boxesOf(body).length);
    expect(toggleTaskAt(body, 0)).toContain('- [x] real one');
    expect(toggleTaskAt(body, 0)).toContain('```\n- [ ] inside fence\n```');
    expect(toggleTaskAt(body, 1)).toContain('- [x] real two');
  });
  it('handles tilde fences, longer fences, indented fences and unclosed fences', () => {
    const body = '~~~\n- [ ] t1\n~~~\n\n````md\n```\n- [ ] t2\n```\n````\n\n   ```\n- [ ] t3\n   ```\n\n- [ ] live\n\n```\n- [ ] swallowed to the end';
    expect(taskSlots(body)).toHaveLength(1);
    expect(toggleTaskAt(body, 0)).toBe(body.replace('- [ ] live', '- [x] live'));
  });
  it('counts tasks in blockquotes and skips indented code', () => {
    const body = '> - [ ] quoted\n> > - [x] deep\n\ntext\n\n    - [ ] indented code\n\n- [ ] after';
    expect(states(body)).toEqual([false, true, false]);
    expect(toggleTaskAt(body, 1)).toBe(body.replace('[x] deep', '[ ] deep'));
    expect(toggleTaskAt(body, 2)).toBe(body.replace('[ ] after', '[x] after'));
  });
  it('treats `- [ ]` without trailing text space as plain text, like marked', () => {
    const body = '- [ ]\n- [ ] \n- [ ]x\n- [ ] real';
    expect(taskSlots(body)).toHaveLength(boxesOf(body).length);
    expect(toggleTaskAt(body, 1)).toBe('- [ ]\n- [ ] \n- [ ]x\n- [x] real');
  });
  it('maps two tasks written on one line, and preserves CRLF and lone-CR line endings', () => {
    expect(toggleTaskAt('- [ ] - [ ] x', 1)).toBe('- [ ] - [x] x');
    expect(toggleTaskAt('- [ ] - [ ] x', 0)).toBe('- [x] - [ ] x');
    expect(toggleTaskAt('a\r\n\r\n- [ ] one\r\n- [ ] two\r\n', 1)).toBe('a\r\n\r\n- [ ] one\r\n- [x] two\r\n');
    expect(toggleTaskAt('- [ ] one\r- [ ] two', 1)).toBe('- [ ] one\r- [x] two');
  });
  it('finds the right line where marked mis-positions tokens (blockquote with a lazy continuation line)', () => {
    const body = '2) [ ] T1 beta\n#lazy line\n> 1. [ ] \n    - [X] T2 alpha\n> \n>     - [X] T3 beta\n> \n> 2. [] T4 gamma\n';
    expect(states(body)).toEqual([false, true]);
    expect(toggleTaskAt(body, 1)).toBe(body.replace('[X] T2', '[ ] T2'));
    expect(toggleTaskAt(body, 0)).toBe(body.replace('[ ] T1', '[x] T1'));
  });
  it('returns null out of range, for bad input, and for a raw-HTML checkbox', () => {
    expect(toggleTaskAt('- [ ] a', 1)).toBeNull();
    expect(toggleTaskAt('- [ ] a', -1)).toBeNull();
    expect(toggleTaskAt('- [ ] a', 0.5)).toBeNull();
    expect(toggleTaskAt(null, 0)).toBeNull();
    const body = 'x <input type="checkbox"> y\n\n- [ ] real';
    expect(boxesOf(body)).toHaveLength(2);                  // renderMarkdown tags the hand-written input too
    expect(toggleTaskAt(body, 0)).toBeNull();
    expect(toggleTaskAt(body, 1)).toBe(body.replace('[ ] real', '[x] real'));
  });
});

describe('raw HTML the sanitizer or the parser removes', () => {
  const INPUT = '<input type=checkbox>';
  const wraps = [
    (x) => '<!-- ' + x + ' -->', (x) => '<script>' + x + '</script>', (x) => '<style>' + x + '</style>',
    (x) => '<textarea>' + x + '</textarea>', (x) => '<template>' + x + '</template>', (x) => '<noscript>' + x + '</noscript>',
    (x) => '<iframe>' + x + '</iframe>', (x) => '<title>' + x + '</title>', (x) => '<xmp>' + x + '</xmp>',
  ];
  const bodies = [];
  for (const w of wraps) {
    bodies.push(w(INPUT) + '\n\n- [ ] a\n- [ ] b');                        // block HTML
    bodies.push('x ' + w(INPUT) + ' y\n\n- [ ] a\n- [ ] b');                // inline HTML, split over inline tokens
    bodies.push(w('\n' + INPUT + '\n') + '\n\n- [ ] a\n- [ ] b');          // block spanning lines
  }
  it('counts only the checkboxes that survive rendering, so clicking b flips b', () => {
    for (const body of bodies) {
      const boxes = boxesOf(body);
      expect(taskSlots(body).length, JSON.stringify(body)).toBe(boxes.length);
      expect(toggleTaskAt(body, boxes.length - 1), JSON.stringify(body)).toBe(body.replace('- [ ] b', '- [x] b'));
      expect(toggleTaskAt(body, boxes.length - 2), JSON.stringify(body)).toBe(body.replace('- [ ] a', '- [x] a'));
    }
  });
  it('the review case: a commented-out checkbox before two tasks', () => {
    const body = '<!-- <input type=checkbox> -->\n\n- [ ] a\n- [ ] b';
    expect(boxesOf(body)).toHaveLength(2);
    expect(toggleTaskAt(body, 1)).toBe('<!-- <input type=checkbox> -->\n\n- [ ] a\n- [x] b');
  });
  it('an unclosed raw element that swallows the tasks after it leaves nothing to toggle', () => {
    for (const body of ['x <textarea>\n\n- [ ] a\n- [ ] b', 'x <script>\n\n- [ ] a\n- [ ] b', '<!--\n\n- [ ] a\n- [ ] b']) {
      const n = boxesOf(body).length;
      expect(taskSlots(body).length, JSON.stringify(body)).toBe(n);
      for (let i = 0; i < n; i++) expect(toggleTaskAt(body, i)).toBeNull();
    }
  });
  it('a hand-written input that copies the task attributes is still a raw checkbox', () => {
    const body = 'x <input disabled="" type="checkbox" data-tslot="0:0"> y\n\n- [ ] real';
    expect(toggleTaskAt(body, 0)).toBeNull();
    expect(toggleTaskAt(body, 1)).toBe(body.replace('[ ] real', '[x] real'));
  });
});

// ---- property test: rendered checkboxes vs the counter, over generated documents ----
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function generate(seed) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)], chance = (p) => r() < p;
  let label = 0, raw = 0;
  const words = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(['alpha', 'beta', 'gamma', 'delta', '#tag', '[[Link]]', '$x^2$', '**bold**', '`code`'])).join(' ');
  const taskText = () => (chance(0.1) ? '' : 'T' + (label++) + ' ' + words());
  const MARK = ['[ ] ', '[ ] ', '[x] ', '[X] ', '[ ] ', '[] ', '[  ] ', '[x]', '[ ]'];   // the tail ones are not tasks
  const para = () => Array.from({ length: 1 + Math.floor(r() * 2) }, words);
  const fenceLines = () => {
    const ch = pick(['`', '~']), n = 3 + Math.floor(r() * 3), ind = ' '.repeat(Math.floor(r() * 4));
    const inner = Array.from({ length: Math.floor(r() * 4) }, () => pick(['- [ ] T' + (label++) + ' in code', '1. [x] T' + (label++) + ' in code', '', ch.repeat(2), 'plain', '  - [ ] T' + (label++)]));
    return [ind + ch.repeat(n) + pick(['', 'js', ' md']), ...inner, ...(chance(0.8) ? [ind + ch.repeat(n + Math.floor(r() * 2))] : [])];
  };
  const indentOf = (m) => pick([' '.repeat(m.length), '  ', '    ', '\t', ' '.repeat(m.length)]);
  function list(depth) {
    const m = pick(['-', '*', '+', '1.', '1)', '7.']), loose = chance(0.3), lines = [];
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
      const num = /\d/.test(m) ? m.replace(/\d+/, String(k + 1)) : m;
      const first = pick(MARK), txt = first.startsWith('[') && !chance(0.1) ? taskText() : 'T' + (label++) + ' ' + words();
      lines.push(num + ' ' + (chance(0.15) ? '' : first) + (chance(0.04) ? '- [ ] T' + (label++) + ' same line' : txt));
      const pad = indentOf(num);
      if (depth < 3) for (let c = 0; c < Math.floor(r() * 2.2); c++) lines.push(...block(depth + 1).map((l) => (l === '' ? l : pad + l)));
      if (loose || chance(0.1)) lines.push('');
    }
    return lines;
  }
  function block(depth) {
    const x = r();
    if (x < 0.34) return list(depth);
    if (x < 0.46) return fenceLines();
    if (x < 0.56) return ['', '    - [ ] T' + (label++) + ' indented code', ''];
    if (x < 0.68 && depth < 3) { const q = block(depth + 1); return q.map((l) => (chance(0.9) ? '> ' + l : l)); }
    if (x < 0.72) return ['<div>', '- [ ] T' + (label++) + ' html block', '</div>', ''];
    if (x < 0.76) return ['$$', '- [ ] T' + (label++) + ' math', '$$', ''];
    if (x < 0.8) return ['x <input type="checkbox" id="raw' + (raw++) + '"> y', ''];
    if (x < 0.83) {   // raw checkboxes the sanitizer drops, block and inline, and an inline one split over tokens
      const tag = pick(['script', 'style', 'textarea', 'template', 'noscript', 'iframe']), inp = '<input type="checkbox" id="gone' + (raw++) + '">';
      return pick([['<!-- ' + inp + ' -->', ''], ['x <!-- ' + inp + ' --> y', ''], ['<' + tag + '>', inp, '</' + tag + '>', ''], ['x <' + tag + '>' + inp + '</' + tag + '> y', '']]);
    }
    if (x < 0.84) return ['| a | b |', '|---|---|', '| - [ ] T' + (label++) + ' | y |', ''];
    if (x < 0.88) return pick([['---'], ['***'], ['Setext title', '---'], ['## heading']]);
    return para();
  }
  const out = [];
  for (let b = 0; b < 2 + Math.floor(r() * 5); b++) { out.push(...block(0)); if (chance(0.7)) out.push(''); }
  return out.join(pick(['\n', '\n', '\n', '\r\n', '\r']));
}

describe('property: counter vs rendered checkboxes', () => {
  beforeAll(() => { /* markdown.js renders math as a placeholder until KaTeX loads; checkbox structure is unaffected */ });
  const N = 600;
  it('data-task count equals the counter, and toggling i flips exactly the i-th rendered checkbox', () => {
    let tasks = 0, withFence = 0, withRaw = 0, withGone = 0;
    for (let seed = 1; seed <= N; seed++) {
      const body = generate(seed), ctx = 'seed ' + seed + ' ' + JSON.stringify(body);
      const boxes = boxesOf(body), slots = taskSlots(body), before = boxes.map((b) => b.checked);
      expect(slots.length, ctx).toBe(boxes.length);
      if (/^ {0,3}(```|~~~)/m.test(body)) withFence++;
      if (body.includes('id="gone')) withGone++;
      boxes.forEach((box, i) => {
        if (box.id.startsWith('raw') || box.id.startsWith('gone')) {   // raw HTML (a <noscript> one survives sanitizing)
         withRaw++; expect(toggleTaskAt(body, i), ctx).toBeNull(); return; }
        tasks++;
        const next = toggleTaskAt(body, i); expect(next, ctx + ' #' + i).not.toBeNull();
        // exactly one character changed, between ' ' and x/X
        expect(next.length, ctx).toBe(body.length);
        const diff = [...body].map((c, k) => (c === next[k] ? -1 : k)).filter((k) => k >= 0);
        expect(diff.length, ctx + ' #' + i).toBe(1);
        expect([body[diff[0]], next[diff[0]]].sort().join(''), ctx).toMatch(/^ [xX]$/);
        // the re-rendered note differs from the original only at checkbox i
        const after = states(next);
        expect(after, ctx + ' #' + i).toEqual(before.map((v, k) => (k === i ? !v : v)));
        // and the flipped source line carries the label the clicked checkbox renders next to
        const lbl = (box.closest('li') && /T\d+/.exec(box.closest('li').textContent)) || null;
        const lineStart = Math.max(body.lastIndexOf('\n', diff[0]), body.lastIndexOf('\r', diff[0])) + 1;
        const line = body.slice(lineStart).split(/\r\n|\r|\n/, 1)[0];
        const own = /T\d+/.exec(line);
        if (lbl && own) expect(line, ctx + ' #' + i).toMatch(new RegExp('\\b' + lbl[0] + '\\b'));
      });
    }
    // the generator must actually exercise the interesting constructs
    expect(tasks).toBeGreaterThan(600); expect(withFence).toBeGreaterThan(100); expect(withRaw).toBeGreaterThan(10); expect(withGone).toBeGreaterThan(10);
  }, 120000);
});
