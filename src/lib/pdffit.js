// Fit-width scale for a PDF page in the side reader: the available client width (minus a small
// gutter) divided by the page's natural width at scale 1, clamped to a readable range. Pure so the
// autofit math is unit-testable without a DOM or pdf.js.
export function computeFitScale(clientWidth, pageWidth, gutter = 30, min = 0.25, max = 3) {
  if (!(pageWidth > 0)) return min;
  const avail = (clientWidth || 620) - gutter;
  return Math.max(min, Math.min(max, avail / pageWidth));
}
