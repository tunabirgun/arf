import { describe, it, expect } from 'vitest';
import { computeFitScale } from '../../src/lib/pdffit.js';

// A4 portrait at scale 1 is ~595 CSS px wide; the fit math is (clientWidth - gutter) / pageWidth.
const A4 = 595;

describe('computeFitScale', () => {
  it('fits the page to the available width minus the gutter', () => {
    // 625px panel − 30px gutter = 595 avail → exactly 1× for an A4 page
    expect(computeFitScale(625, A4)).toBeCloseTo(1, 5);
    // a wider panel scales the page up proportionally
    expect(computeFitScale(1220, A4)).toBeCloseTo((1220 - 30) / A4, 5);
  });

  it('tracks the panel: a wider panel yields a larger scale than a narrower one', () => {
    expect(computeFitScale(900, A4)).toBeGreaterThan(computeFitScale(500, A4));
  });

  it('clamps to the readable range [0.25, 3]', () => {
    expect(computeFitScale(60, A4)).toBe(0.25);       // tiny panel floors at 0.25
    expect(computeFitScale(6000, A4)).toBe(3);        // huge panel caps at 3
  });

  it('falls back to a sane width when clientWidth is 0/unknown', () => {
    expect(computeFitScale(0, A4)).toBeCloseTo((620 - 30) / A4, 5);
  });

  it('returns the floor for a degenerate page width', () => {
    expect(computeFitScale(800, 0)).toBe(0.25);
    expect(computeFitScale(800, -1)).toBe(0.25);
  });

  it('respects custom gutter and clamp bounds', () => {
    expect(computeFitScale(500, A4, 0, 0.1, 5)).toBeCloseTo(500 / A4, 5);
  });
});
