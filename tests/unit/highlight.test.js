import { describe, it, expect } from 'vitest';
import { buildMatchIndex, coveredSegments, coveredIntervals, coerceHl, hlText, HL_DEFAULT } from '../../src/lib/highlight.js';

describe('coveredSegments (pdf.js span path)', () => {
  // The bug: a PDF text layer splits "(Smith, 2020)" into separate spans, so the old matcher (which
  // forced a space between spans) searched for "( smith, 2020 )" and never found "(smith, 2020)".
  it('matches a bracketed citation split across spans', () => {
    const spans = ['(', 'Smith,', '2020)'];   // punctuation on its own run, no spaces between
    const idx = buildMatchIndex(spans);
    const hit = coveredSegments(idx, '(Smith, 2020)');
    expect([...hit].sort()).toEqual([0, 1, 2]);
  });
  it('matches square brackets and reference numerals across spans', () => {
    const spans = ['see', '[', '12', ']', 'above'];
    const idx = buildMatchIndex(spans);
    expect([...coveredSegments(idx, '[12]')].sort()).toEqual([1, 2, 3]);
  });
  it('is insensitive to inter-span spacing differences', () => {
    const spans = ['The', 'quick', 'brown'];
    const idx = buildMatchIndex(spans);
    expect([...coveredSegments(idx, 'the quick brown')].sort()).toEqual([0, 1, 2]);
    expect([...coveredSegments(idx, 'thequickbrown')].sort()).toEqual([0, 1, 2]);
  });
  it('ignores needles under 3 non-space chars', () => {
    expect(coveredSegments(buildMatchIndex(['ab']), 'ab').size).toBe(0);
  });
});

describe('coveredIntervals (HTML text-node path)', () => {
  // The bug: a sentence spanning inline elements ([[wikilink]] → <a>, bold → <strong>) becomes several
  // text nodes; Range.surroundContents() throws across element boundaries, so no <mark> was applied.
  it('spans a match across three text nodes (link in the middle)', () => {
    const nodes = ['See ', 'Welcome to Arf', ' for the intro'];   // <a> splits the sentence
    const idx = buildMatchIndex(nodes);
    const ivs = coveredIntervals(idx, 'See Welcome to Arf for the intro');
    expect(ivs.map((x) => x.seg)).toEqual([0, 1, 2]);
    // each interval spans from the first to the last non-space char of its node (edge spaces dropped)
    expect(nodes[0].slice(ivs[0].a, ivs[0].b)).toBe('See');
    expect(nodes[1].slice(ivs[1].a, ivs[1].b)).toBe('Welcome to Arf');
    expect(nodes[2].slice(ivs[2].a, ivs[2].b)).toBe('for the intro');
  });
  it('matches a partial phrase inside one node with correct offsets', () => {
    const nodes = ['alpha beta gamma delta'];
    const [iv] = coveredIntervals(buildMatchIndex(nodes), 'beta gamma');
    expect(nodes[0].slice(iv.a, iv.b)).toBe('beta gamma');
  });
  it('matches a bracketed phrase across nodes', () => {
    const nodes = ['the set ', '{a, b}', ' is closed'];
    const idx = buildMatchIndex(nodes);
    const ivs = coveredIntervals(idx, 'the set {a, b} is closed');
    expect(ivs.map((x) => x.seg)).toEqual([0, 1, 2]);
  });
});

describe('coerceHl / hlText', () => {
  it('coerces a legacy string highlight to the default colour', () => {
    expect(coerceHl('a passage')).toEqual({ text: 'a passage', color: HL_DEFAULT });
  });
  it('keeps a valid colour and rejects an unknown one', () => {
    expect(coerceHl({ text: 'x', color: 'green' })).toEqual({ text: 'x', color: 'green' });
    expect(coerceHl({ text: 'x', color: 'chartreuse' })).toEqual({ text: 'x', color: HL_DEFAULT });
  });
  it('reads the text of either shape', () => {
    expect(hlText('plain')).toBe('plain');
    expect(hlText({ text: 'obj', color: 'blue' })).toBe('obj');
  });
});
