// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown, setLinkResolver, setCiteResolver } from '../../src/lib/markdown.js';

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
});
