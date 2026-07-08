import { describe, it, expect } from 'vitest';
import { formatRef, joinRefs, CITE_STYLES } from '../../src/lib/cite.js';

const article = {
  citekey: 'smith2020', type: 'article-journal', title: 'A Study of Things',
  authors: [{ f: 'Smith', g: 'Jane' }, { f: 'Doe', g: 'John' }],
  year: 2020, container: 'Journal of Things', volume: '12', pages: '34-56', doi: '10.1/x',
};
const book = {
  citekey: 'jones2019', type: 'book', title: 'The Book',
  authors: [{ f: 'Jones', g: 'Amy' }], year: 2019, publisher: 'Uni Press', isbn: '978-0',
};

describe('formatRef', () => {
  it('APA formats authors, year, container, volume, pages, and DOI', () => {
    expect(formatRef(article, 'APA')).toBe(
      'Smith, J., & Doe, J. (2020). A Study of Things. Journal of Things, 12, 34-56. https://doi.org/10.1/x',
    );
  });

  it('Nature lists initials-after-surname and year in parentheses', () => {
    const out = formatRef(article, 'Nature');
    expect(out).toContain('Smith, J.');
    expect(out).toContain('A Study of Things.');
    expect(out).toContain('(2020).');
  });

  it('BibTeX emits the right entry type, en-dash page range, and joined authors', () => {
    const out = formatRef(article, 'BibTeX');
    expect(out.startsWith('@article{smith2020,')).toBe(true);
    expect(out).toContain('author = {Smith, Jane and Doe, John}');
    expect(out).toContain('pages = {34--56}');
    expect(out).toContain('journal = {Journal of Things}');
  });

  it('BibTeX escapes LaTeX-special characters in a title', () => {
    const out = formatRef({ ...article, title: 'Cost & Scope_1 {50%}' }, 'BibTeX');
    expect(out).toContain('Cost \\& Scope\\_1 \\{50\\%\\}');
  });

  it('BibTeX escapes a literal backslash so the entry still compiles', () => {
    const out = formatRef({ ...article, title: '$\\alpha$-decay' }, 'BibTeX');
    // the backslash becomes a text-mode command, not a raw control sequence, and $ is escaped
    expect(out).toContain('\\textbackslash ');
    expect(out).not.toContain('{$\\alpha$-decay}');
  });

  it('BibTeX uses @book and publisher for a book', () => {
    const out = formatRef(book, 'BibTeX');
    expect(out.startsWith('@book{jones2019,')).toBe(true);
    expect(out).toContain('publisher = {Uni Press}');
    expect(out).toContain('isbn = {978-0}');
  });

  it('RIS emits typed tags and splits the page range', () => {
    const out = formatRef(article, 'RIS (EndNote)');
    expect(out).toContain('TY  - JOUR');
    expect(out).toContain('AU  - Smith, Jane');
    expect(out).toContain('SP  - 34');
    expect(out).toContain('EP  - 56');
    expect(out.trimEnd().endsWith('ER  -')).toBe(true);
  });

  it('RIS collapses newlines in a field so no orphan line breaks the record', () => {
    const out = formatRef({ ...article, title: 'First line\nsecond line' }, 'RIS (EndNote)');
    expect(out).toContain('TI  - First line second line');
    // every non-empty line must carry a two-letter RIS tag
    out.split('\n').filter(Boolean).forEach((line) => expect(line).toMatch(/^[A-Z][A-Z0-9]  - /));
  });

  it('CSL-JSON is valid JSON with the expected fields', () => {
    const o = JSON.parse(formatRef(article, 'CSL-JSON').trim());
    expect(o.id).toBe('smith2020');
    expect(o.DOI).toBe('10.1/x');
    expect(o.author[0]).toEqual({ family: 'Smith', given: 'Jane' });
    expect(o.issued['date-parts']).toEqual([[2020]]);
  });

  it('Zenodo metadata is valid JSON with the mapped upload type', () => {
    const o = JSON.parse(formatRef(article, 'Zenodo').trim());
    expect(o.upload_type).toBe('publication');
    expect(o.publication_type).toBe('article');
    expect(o.journal_title).toBe('Journal of Things');
  });

  it('exposes every advertised style and falls back to APA for an unknown one', () => {
    expect(CITE_STYLES).toContain('APA');
    expect(formatRef(article, 'NoSuchStyle')).toBe(formatRef(article, 'APA'));
  });
});

describe('joinRefs', () => {
  it('wraps JSON styles in an array', () => {
    const out = joinRefs([article, book], 'CSL-JSON');
    expect(out.startsWith('[')).toBe(true);
    expect(out.trimEnd().endsWith(']')).toBe(true);
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    expect(JSON.parse(out).length).toBe(2);
  });
  it('separates text styles with a blank line', () => {
    expect(joinRefs([article, book], 'APA')).toContain('\n\n');
  });
});
