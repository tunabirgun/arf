import { describe, it, expect } from 'vitest';
import { resolveHref, dirOf, opfPathFromContainer } from '../../src/lib/epub.js';

describe('resolveHref', () => {
  it('joins a relative href to a base directory', () => {
    expect(resolveHref('OEBPS', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolveHref('', 'content.opf')).toBe('content.opf');
  });
  it('collapses ./ and ../ segments', () => {
    expect(resolveHref('OEBPS/text', '../images/cover.jpg')).toBe('OEBPS/images/cover.jpg');
    expect(resolveHref('OEBPS/text', './ch2.xhtml')).toBe('OEBPS/text/ch2.xhtml');
  });
  it('drops a #fragment and ?query', () => {
    expect(resolveHref('OEBPS', 'ch1.xhtml#section2')).toBe('OEBPS/ch1.xhtml');
  });
  it('resolves a root-absolute href from the zip root, not the base dir', () => {
    expect(resolveHref('OEBPS/text', '/images/cover.jpg')).toBe('images/cover.jpg');
  });
});

describe('dirOf', () => {
  it('returns the directory part, or empty for a root file', () => {
    expect(dirOf('OEBPS/text/ch1.xhtml')).toBe('OEBPS/text');
    expect(dirOf('content.opf')).toBe('');
  });
});

describe('opfPathFromContainer', () => {
  it('reads the rootfile full-path from container.xml', () => {
    const xml = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    expect(opfPathFromContainer(xml)).toBe('OEBPS/content.opf');
  });
  it('returns empty when there is no rootfile', () => {
    expect(opfPathFromContainer('<container></container>')).toBe('');
  });
});
