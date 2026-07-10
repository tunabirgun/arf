// Whitespace-insensitive text matching for reader highlights. Kept pure (no DOM) so the reader's two
// surfaces — the note/HTML flow and the pdf.js text layer — share one matcher, and so the bracket /
// cross-boundary cases can be unit-tested. Matching ignores ALL whitespace because a PDF text layer
// splits tightly-set punctuation like "(" or "[" into their own spans (breaking a plain indexOf), and
// rendered Markdown splits a sentence across inline elements ([[links]], [@cites], bold).

export const HL_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
export const HL_DEFAULT = 'yellow';

// Coerce a stored highlight to { text, color }. Legacy highlights are bare strings; an unknown colour
// falls back to the default so a hand-edited sidecar can't produce an unstyled mark.
export function coerceHl(h) {
  if (typeof h === 'string') return { text: h, color: HL_DEFAULT };
  const text = (h && typeof h.text === 'string') ? h.text : '';
  const color = (h && HL_COLORS.includes(h.color)) ? h.color : HL_DEFAULT;
  return { text, color };
}
export function hlText(h) { return typeof h === 'string' ? h : (h && typeof h.text === 'string' ? h.text : ''); }

function normalizeNeedle(s) { return (s == null ? '' : String(s)).replace(/\s+/g, '').toLowerCase(); }

// Index a list of segment strings (text-node values, or text-layer span texts) into one whitespace-
// free, lowercased haystack, remembering for every haystack char which segment it came from and its
// offset within that segment. That lets a match map back to the exact DOM positions to mark.
export function buildMatchIndex(segments) {
  let norm = ''; const seg = [], off = [];
  for (let s = 0; s < segments.length; s++) {
    const t = segments[s] == null ? '' : String(segments[s]);
    for (let c = 0; c < t.length; c++) {
      if (/\s/.test(t[c])) continue;
      norm += t[c].toLowerCase(); seg.push(s); off.push(c);
    }
  }
  return { norm, seg, off };
}

// The set of segment indices any occurrence of `needle` touches — for the pdf.js path, which marks
// whole spans rather than splitting text.
export function coveredSegments(index, needle) {
  const n = normalizeNeedle(needle); const set = new Set();
  if (n.length < 3) return set;
  let from = 0, i;
  while ((i = index.norm.indexOf(n, from)) >= 0) { for (let k = i; k < i + n.length; k++) set.add(index.seg[k]); from = i + n.length; }
  return set;
}

// Per-segment character intervals covered by any occurrence of `needle` — for the HTML path, which
// wraps the covered slice of each text node. Returns [{ seg, a, b }] with [a, b) offsets within `seg`.
export function coveredIntervals(index, needle) {
  const n = normalizeNeedle(needle); const out = [];
  if (n.length < 3) return out;
  let from = 0, i;
  while ((i = index.norm.indexOf(n, from)) >= 0) {
    let k = i;
    while (k < i + n.length) {
      const s = index.seg[k]; let b = index.off[k]; const a = index.off[k];
      while (k < i + n.length && index.seg[k] === s) { b = index.off[k]; k++; }
      out.push({ seg: s, a, b: b + 1 });
    }
    from = i + n.length;
  }
  return out;
}
