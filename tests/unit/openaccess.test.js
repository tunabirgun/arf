import { describe, it, expect } from 'vitest';
import { looksLikePdf, looksLikeEpub, arxivIdOf, bareDoi, discoverOaPdfUrls, fetchOaPdf } from '../../src/lib/openaccess.js';

function epubBytes() {
  const arr = new Uint8Array(1200);
  arr.set([0x50, 0x4b, 0x03, 0x04], 0);            // PK\x03\x04
  const mt = 'mimetypeapplication/epub+zip';
  for (let i = 0; i < mt.length; i++) arr[30 + i] = mt.charCodeAt(i);
  return arr;
}

describe('looksLikeEpub', () => {
  it('accepts a ZIP declaring application/epub+zip', () => {
    expect(looksLikeEpub(epubBytes())).toBe(true);
  });
  it('rejects a PDF and a plain ZIP without the mimetype', () => {
    const pdf = new Uint8Array(1200); pdf.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    expect(looksLikeEpub(pdf)).toBe(false);
    const zip = new Uint8Array(1200); zip.set([0x50, 0x4b, 0x03, 0x04], 0);
    expect(looksLikeEpub(zip)).toBe(false);
  });
});

// build a byte buffer that starts with %PDF- and is padded past the size floor
function pdfBytes(lead = '') {
  const head = lead + '%PDF-1.7\n';
  const arr = new Uint8Array(2048);
  for (let i = 0; i < head.length; i++) arr[i] = head.charCodeAt(i);
  return arr;
}
function textBytes(s, len = 2048) {
  const arr = new Uint8Array(len);
  for (let i = 0; i < Math.min(s.length, len); i++) arr[i] = s.charCodeAt(i);
  return arr;
}

describe('looksLikePdf', () => {
  it('accepts a buffer beginning with %PDF-', () => {
    expect(looksLikePdf(pdfBytes())).toBe(true);
  });
  it('tolerates a few leading bytes before %PDF-', () => {
    expect(looksLikePdf(pdfBytes('﻿   '))).toBe(true);
  });
  it('rejects an HTML landing page', () => {
    expect(looksLikePdf(textBytes('<!doctype html><html><head><title>Paywall</title>'))).toBe(false);
  });
  it('rejects a tiny/empty body below the size floor', () => {
    expect(looksLikePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(false);
    expect(looksLikePdf(null)).toBe(false);
  });
});

describe('arxivIdOf', () => {
  it('reads the id from a DataCite arXiv DOI, stripping the version', () => {
    expect(arxivIdOf({ doi: '10.48550/arXiv.1706.03762' })).toBe('1706.03762');
    expect(arxivIdOf({ doi: '10.48550/arXiv.2001.00001v3' })).toBe('2001.00001');
  });
  it('reads the id from an arxiv.org abs/pdf URL', () => {
    expect(arxivIdOf({ url: 'https://arxiv.org/abs/2001.00001v2' })).toBe('2001.00001');
    expect(arxivIdOf({ url: 'https://arxiv.org/pdf/1912.01703.pdf' })).toBe('1912.01703');
  });
  it('tolerates a query string or fragment on the URL', () => {
    expect(arxivIdOf({ url: 'https://arxiv.org/pdf/2301.12345?download=1' })).toBe('2301.12345');
    expect(arxivIdOf({ url: 'https://arxiv.org/abs/2301.12345v2#top' })).toBe('2301.12345');
  });
  it('returns null when there is no arXiv identifier', () => {
    expect(arxivIdOf({ doi: '10.1371/journal.pone.0173664' })).toBe(null);
    expect(arxivIdOf({})).toBe(null);
    expect(arxivIdOf(null)).toBe(null);
  });
});

describe('bareDoi', () => {
  it('strips a doi.org prefix', () => {
    expect(bareDoi('https://doi.org/10.1/x')).toBe('10.1/x');
    expect(bareDoi('http://dx.doi.org/10.1/x')).toBe('10.1/x');
    expect(bareDoi('10.1/x')).toBe('10.1/x');
  });
});

describe('discoverOaPdfUrls', () => {
  it('orders arXiv first, then merges and de-dupes across indexes', async () => {
    const ref = { doi: '10.48550/arXiv.1706.03762', url: 'https://arxiv.org/abs/1706.03762' };
    const httpJson = async (u) => {
      if (u.includes('unpaywall')) return { is_oa: true, best_oa_location: { url_for_pdf: 'https://repo.example/paper.pdf' }, oa_locations: [{ url_for_pdf: 'https://repo.example/paper.pdf' }] };
      if (u.includes('openalex')) return { best_oa_location: { pdf_url: 'https://repo.example/paper.pdf' }, open_access: { oa_url: 'https://oa.example/x' }, locations: [] };
      return null;
    };
    const cands = await discoverOaPdfUrls(ref, httpJson);
    expect(cands[0].url).toBe('https://arxiv.org/pdf/1706.03762');
    expect(cands[0].source).toBe('arXiv');
    // the duplicate repo URL appears once despite Unpaywall + OpenAlex both returning it
    expect(cands.filter((c) => c.url === 'https://repo.example/paper.pdf').length).toBe(1);
  });

  it('resolves a PMCID via Semantic Scholar and builds a Europe PMC URL', async () => {
    const ref = { doi: '10.1371/journal.pone.0173664' };
    const httpJson = async (u) => {
      if (u.includes('semanticscholar')) return { externalIds: { PMCID: 'PMC5348010' } };
      return null;
    };
    const cands = await discoverOaPdfUrls(ref, httpJson);
    expect(cands.some((c) => c.url === 'https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC5348010&blobtype=pdf')).toBe(true);
  });

  it('orders repository copies ahead of the publisher copy', async () => {
    const ref = { doi: '10.1/x' };
    const httpJson = async (u) => {
      if (u.includes('unpaywall')) return { is_oa: true, oa_locations: [
        { url_for_pdf: 'https://publisher.example/vor.pdf', host_type: 'publisher' },
        { url_for_pdf: 'https://repo.example/green.pdf', host_type: 'repository' },
      ] };
      return null;
    };
    const cands = await discoverOaPdfUrls(ref, httpJson);
    expect(cands[0].url).toBe('https://repo.example/green.pdf');
    expect(cands[1].url).toBe('https://publisher.example/vor.pdf');
  });

  it('ignores null pdf URLs and a source that throws', async () => {
    const ref = { doi: '10.1/x' };
    const httpJson = async (u) => {
      if (u.includes('unpaywall')) throw new Error('down');
      if (u.includes('openalex')) return { best_oa_location: { pdf_url: null }, open_access: { oa_url: 'https://good.example/x.pdf' } };
      return null;
    };
    const cands = await discoverOaPdfUrls(ref, httpJson);
    expect(cands.length).toBe(1);
    expect(cands[0].url).toBe('https://good.example/x.pdf');
  });

  it('yields nothing when the reference has no usable identifier', async () => {
    const cands = await discoverOaPdfUrls({ title: 'A book' }, async () => null);
    expect(cands).toEqual([]);
  });
});

describe('fetchOaPdf', () => {
  it('skips an HTML interstitial and keeps the first real PDF', async () => {
    const ref = { doi: '10.1/x' };
    const httpJson = async () => ({ is_oa: true, best_oa_location: { url_for_pdf: 'https://a.example/landing' }, oa_locations: [{ url_for_pdf: 'https://b.example/real.pdf' }] });
    const httpBytes = async (u) => u.includes('real') ? pdfBytes() : textBytes('<html>paywall</html>');
    const r = await fetchOaPdf(ref, httpJson, httpBytes);
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://b.example/real.pdf');
    expect(looksLikePdf(r.bytes)).toBe(true);
  });

  it('reports failure with the list it tried when no candidate is a PDF', async () => {
    const ref = { doi: '10.1/x' };
    const httpJson = async () => ({ is_oa: true, best_oa_location: { url_for_pdf: 'https://a.example/landing' } });
    const httpBytes = async () => textBytes('<html>nope</html>');
    const r = await fetchOaPdf(ref, httpJson, httpBytes);
    expect(r.ok).toBe(false);
    expect(r.tried).toContain('https://a.example/landing');
    expect(r.firstUrl).toBe('https://a.example/landing');
  });

  it('treats a candidate that throws (403/timeout) as a skip', async () => {
    const ref = { doi: '10.48550/arXiv.1706.03762' };
    const httpJson = async () => null;
    const httpBytes = async () => { throw new Error('403'); };
    const r = await fetchOaPdf(ref, httpJson, httpBytes);
    expect(r.ok).toBe(false);
    expect(r.tried).toEqual(['https://arxiv.org/pdf/1706.03762']);
  });
});
