// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { renderMarkdown, setLinkResolver, setCiteResolver, parseImageAlt, withSizeHint, numberFigures, loadMath } from '../../src/lib/markdown.js';
import mathExpected from './fixtures/math-expected.json';

beforeAll(() => loadMath()); // KaTeX is lazy; the suite below renders math

setLinkResolver((t) => (t === 'foo' ? { id: 'x1' } : null));
setCiteResolver((k) => (k === 'guth1981' ? { authors: [{ f: 'Guth' }], year: 1981, title: 'Inflation' } : null));

describe('renderMarkdown', () => {
  it('renders a resolved wikilink as a navigable anchor', () => {
    const html = renderMarkdown('see [[Foo]]');
    expect(html).toContain('data-nav="x1"');
    expect(html).toContain('class="wl"');
  });
  it('marks an unresolved wikilink as dangling', () => {
    expect(renderMarkdown('[[Nope]]')).toContain('dangling');
  });
  it('renders an inline #tag as a tag anchor', () => {
    expect(renderMarkdown('a #hello b')).toContain('data-tag="hello"');
  });
  it('renders a resolved citation with an author-year label', () => {
    const html = renderMarkdown('as shown [@guth1981]');
    expect(html).toContain('data-cite="guth1981"');
    expect(html).toContain('Guth 1981');
  });
  it('in-text-only citation [@!key] still renders the inline marker', () => {
    const html = renderMarkdown('as shown [@!guth1981]');
    expect(html).toContain('data-cite="guth1981"');
    expect(html).toContain('Guth 1981');
  });
  it('reference-only citation [@+key] renders no in-text marker (nocite)', () => {
    const html = renderMarkdown('background [@+guth1981] here');
    expect(html).not.toContain('data-cite');
    expect(html).not.toContain('Guth 1981');
    expect(html).toContain('background');
    expect(html).toContain('here');
  });
  it('typesets inline and display math with KaTeX', () => {
    expect(renderMarkdown('$x^2$')).toContain('katex');
    expect(renderMarkdown('$$x^2$$')).toContain('math-display');
  });
  it('strips a script tag (external .md files are untrusted)', () => {
    const html = renderMarkdown('hi <script>alert(1)</script> there');
    expect(html).not.toContain('<script');
  });
  it('strips an inline event handler', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });
  it('makes a GFM task checkbox interactive (data-task, not disabled)', () => {
    const html = renderMarkdown('- [ ] a task');
    expect(html).toContain('data-task');
    expect(html).not.toContain('disabled');
  });
  it('applies an image width hint as an inline style, keeping the caption as alt', () => {
    const html = renderMarkdown('![A cell|320](img.png)');
    expect(html).toMatch(/width:\s*320px/);
    expect(html).toContain('alt="A cell"');
    expect(html).toContain('data-imw="320"');
  });
  it('renders a standalone captioned image as a numbered figure', () => {
    const html = renderMarkdown('![First plot](a.png)\n\n![Second plot](b.png)');
    expect(html).toContain('<figure');
    expect(html).toContain('Figure 1');
    expect(html).toContain('First plot');
    expect(html).toContain('Figure 2');
    expect(html).toContain('Second plot');
  });
  it('does not double-escape special characters in an image caption', () => {
    const html = renderMarkdown('![Cats & Dogs|300](a.png)');
    expect(html).toContain('alt="Cats &amp; Dogs"');   // single-escaped alt, not &amp;amp;
    expect(html).toContain('— Cats &amp; Dogs');        // single-escaped figure caption
    expect(html).not.toContain('&amp;amp;');
  });
  it('marks only inline images with data-imw (reference-style images are not control-clickable)', () => {
    expect(renderMarkdown('![cap|300](a.png)')).toContain('data-imw');
    expect(renderMarkdown('![cap|300][r]\n\n[r]: b.png')).not.toContain('data-imw');
  });
  it('does not number an uncaptioned standalone image (figure, no figcaption)', () => {
    const html = renderMarkdown('![|200](a.png)');
    expect(html).toContain('<figure');
    expect(html).not.toContain('figcaption');
    expect(html).toMatch(/width:\s*200px/);
  });
});

describe('parseImageAlt / withSizeHint', () => {
  it('splits caption and width from the alt', () => {
    expect(parseImageAlt('My figure|400')).toEqual({ cap: 'My figure', w: 400, h: null });
    expect(parseImageAlt('Cell|320x240')).toEqual({ cap: 'Cell', w: 320, h: 240 });
    expect(parseImageAlt('just a caption')).toEqual({ cap: 'just a caption', w: null, h: null });
    expect(parseImageAlt('|180')).toEqual({ cap: '', w: 180, h: null });
  });
  it('rewrites the width hint while preserving the caption', () => {
    expect(withSizeHint('My figure|400', 240)).toBe('My figure|240');
    expect(withSizeHint('My figure|400', null)).toBe('My figure');   // Full width drops the hint
    expect(withSizeHint('plain', 300)).toBe('plain|300');
  });
});

describe('numberFigures', () => {
  it('leaves an inline image (not its own paragraph) alone', () => {
    const html = numberFigures('<p>text <img src="a.png" alt="x"> more</p>');
    expect(html).not.toContain('<figure');
  });
});

// KaTeX loads on demand: before loadMath() math is an escaped placeholder, after it the output must be
// byte-identical to the eager-import renderer. Expected strings in fixtures/math-expected.json were captured
// from the pre-change renderMarkdown (static katex import).
describe('lazy math', () => {
  const fresh = async () => { vi.resetModules(); return import('../../src/lib/markdown.js'); }; // unloaded module state

  it('shows an escaped math-pending placeholder before KaTeX is loaded', async () => {
    const m = await fresh();
    expect(m.mathReady()).toBe(false); expect(m.mathPending()).toBe(false);
    const inline = m.renderMarkdown('Energy $a < b & "c"$ here');
    expect(inline).toContain('<code class="math-pending">a &lt; b &amp; "c"</code>'); // DOMPurify re-serializes &quot; in text
    expect(inline).not.toContain('katex');
    const display = m.renderMarkdown('$$x^2$$');
    expect(display).toContain('<div class="math-display"><code class="math-pending math-pending-display">x^2</code></div>');
    expect(m.mathPending()).toBe(true);
  });
  it('keeps hostile TeX inert through DOMPurify', async () => {
    const m = await fresh();
    const html = m.renderMarkdown('x $<img src=x onerror=alert(1)>$ y\n\n$$<script>alert(1)</script>$$');
    const box = document.createElement('div'); box.innerHTML = html;
    expect(box.querySelector('img, script')).toBeNull();      // the TeX is text, never an element
    expect(box.querySelector('[onerror]')).toBeNull();
    expect(box.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('does not flag pending for prose without math', async () => {
    const m = await fresh();
    m.renderMarkdown('it costs $5 and $10 total, no math here');
    expect(m.mathPending()).toBe(false);
  });
  it('loadMath is idempotent, notifies listeners once, and clears pending', async () => {
    const m = await fresh();
    m.renderMarkdown('$x$');
    expect(m.mathPending()).toBe(true);
    const cb = vi.fn(); const off = m.onMathReady(cb); const never = vi.fn(); m.onMathReady(never)(); // unsubscribed listener stays silent
    const p1 = m.loadMath(), p2 = m.loadMath();
    expect(p2).toBe(p1);
    await p1; await m.loadMath();
    expect(m.mathReady()).toBe(true); expect(m.mathPending()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1); expect(never).not.toHaveBeenCalled();
    off();
    expect(m.renderMarkdown('$x$')).toContain('class="katex"');
  });
  it('after loading, output is byte-identical to the eager-import renderer', async () => {
    const m = await fresh();
    await m.loadMath();
    for (const [name, { md, html }] of Object.entries(mathExpected)) expect(m.renderMarkdown(md), name).toBe(html);
    expect(Object.keys(mathExpected).length).toBeGreaterThanOrEqual(10);
  });
});
