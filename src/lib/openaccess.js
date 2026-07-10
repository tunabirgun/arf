// Open-access PDF discovery and verification.
//
// This module is network-agnostic: callers inject `httpJson(url)` and `httpBytes(url)`.
// In the desktop app those are backed by Tauri's native HTTP (Rust reqwest), which is NOT
// subject to the webview's CORS wall — the wall is why a plain browser fetch fails on most
// publisher-hosted OA PDFs (PLoS, Nature, MDPI… serve the file with no Access-Control-Allow-Origin).
// Only a reference's own identifiers (DOI, arXiv id, PMCID) ever leave the device — never notes.
//
// Discovery queries several open indexes and collects candidate PDF URLs, most-reliable first;
// the download step then tries each in turn and keeps the first response whose bytes are a real PDF.

// polite-pool contact sent to Unpaywall / OpenAlex (no personal data; a neutral project address)
export const OA_CONTACT = 'arf-app@users.noreply.github.com';

// A real PDF begins with "%PDF-". Some files carry a few leading bytes (BOM/whitespace), so scan a
// small window rather than only offset 0. HTML landing pages and paywall interstitials fail this,
// which is exactly what we want — saving one as .pdf would give the reader an unopenable file.
export function looksLikePdf(bytes) {
  if (!bytes) return false;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 1024) return false;                 // an article PDF is never this small; rejects stub/error bodies
  const cap = Math.min(u8.length, 1024);
  for (let i = 0; i + 4 < cap; i++) {
    if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return true; // %PDF-
  }
  return false;
}

// An EPUB is a ZIP (starts with PK\x03\x04) whose first stored entry declares application/epub+zip.
// Used to verify a fetched book (e.g. a Project Gutenberg download) before saving it as a reader copy.
export function looksLikeEpub(bytes) {
  if (!bytes) return false;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 1000) return false;
  if (!(u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)) return false;
  let head = ''; const cap = Math.min(u8.length, 200);
  for (let i = 0; i < cap; i++) head += String.fromCharCode(u8[i]);
  return head.includes('application/epub+zip') || head.includes('mimetype');
}

// Pull an arXiv id from a reference: its DataCite DOI (10.48550/arXiv.XXXX), an arxiv.org URL, or a
// bare "arXiv:XXXX" identifier. Strips the version suffix so the canonical PDF URL resolves.
export function arxivIdOf(ref) {
  if (!ref) return null;
  const doi = String(ref.doi || '').toLowerCase();
  let m = doi.match(/10\.48550\/arxiv\.(.+)$/);
  if (m) return m[1].replace(/v\d+$/, '');
  m = doi.match(/^arxiv:(.+)$/);
  if (m) return m[1].replace(/v\d+$/, '');
  const url = String(ref.url || '');
  m = url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?(?:[?#]|$)/i);   // tolerate a trailing ?query / #frag
  if (m) return m[1].replace(/v\d+$/, '');
  return null;
}

// strip a DOI down to its bare form (drop a doi.org prefix and surrounding whitespace)
export function bareDoi(doi) {
  return String(doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

// Candidate priority — lower is tried first. Repository copies (arXiv, PMC, Zenodo, OSF,
// institutional) rarely sit behind a bot wall; the publisher copy (MDPI, IEEE, Elsevier, other
// Cloudflare-fronted hosts) is exactly where challenge-403s concentrate. So repository-first.
const PRIO = { arxiv: 0, repository: 1, unknown: 2, publisher: 3, epmc: 4 };
function hostPrio(hostType) {
  const t = String(hostType || '').toLowerCase();
  if (t === 'repository') return PRIO.repository;
  if (t === 'publisher') return PRIO.publisher;
  return PRIO.unknown;
}
function addCand(map, url, source, priority) {
  if (!url || typeof url !== 'string') return;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return;
  const key = u.replace(/#.*$/, '');
  const ex = map.get(key);
  if (!ex || priority < ex.priority) map.set(key, { url: u, source, priority });   // keep the best-priority sighting
}

// Build the candidate PDF URL list for a reference, de-duplicated and ordered most-downloadable
// first (arXiv → repositories → unknown → publishers → Europe PMC render). `httpJson(url)` resolves
// to parsed JSON (or throws / resolves null on failure — each source is wrapped so one being down
// never aborts the rest).
export async function discoverOaPdfUrls(ref, httpJson, opts = {}) {
  const contact = opts.contact || OA_CONTACT;
  const map = new Map();

  // arXiv — openly hosted, serves the PDF with CORS, the single most reliable source
  const ax = arxivIdOf(ref);
  if (ax) addCand(map, 'https://arxiv.org/pdf/' + ax, 'arXiv', PRIO.arxiv);

  const doi = bareDoi(ref && ref.doi);
  let pmcid = ref && ref.pmcid ? String(ref.pmcid) : null;

  if (doi) {
    // Unpaywall — the canonical open-access index; each location tags its host_type
    try {
      const j = await httpJson('https://api.unpaywall.org/v2/' + encodeURIComponent(doi) + '?email=' + encodeURIComponent(contact));
      if (j && j.is_oa) {
        const locs = j.oa_locations && j.oa_locations.length ? j.oa_locations : (j.best_oa_location ? [j.best_oa_location] : []);
        for (const loc of locs) addCand(map, loc && loc.url_for_pdf, 'Unpaywall', hostPrio(loc && loc.host_type));
      }
    } catch (e) { /* source down — skip */ }

    // OpenAlex — best OA location + every located PDF (source.type marks repositories)
    try {
      const j = await httpJson('https://api.openalex.org/works/doi:' + encodeURIComponent(doi) + '?mailto=' + encodeURIComponent(contact));
      if (j) {
        const b = j.best_oa_location;
        if (b) addCand(map, b.pdf_url, 'OpenAlex', hostPrio(b.source && b.source.type));
        if (j.open_access) addCand(map, j.open_access.oa_url, 'OpenAlex', PRIO.unknown);
        for (const loc of (j.locations || [])) if (loc && loc.pdf_url) addCand(map, loc.pdf_url, 'OpenAlex', hostPrio(loc.source && loc.source.type));
      }
    } catch (e) { /* skip */ }

    // Semantic Scholar — its own OA PDF, and a PMCID we can hand to Europe PMC
    try {
      const j = await httpJson('https://api.semanticscholar.org/graph/v1/paper/DOI:' + encodeURIComponent(doi) + '?fields=openAccessPdf,externalIds');
      if (j) {
        if (j.openAccessPdf) addCand(map, j.openAccessPdf.url, 'Semantic Scholar', PRIO.unknown);
        if (!pmcid && j.externalIds && j.externalIds.PMCID) pmcid = String(j.externalIds.PMCID);
      }
    } catch (e) { /* skip */ }

    // Europe PMC — resolve a PMCID if none yet
    if (!pmcid) {
      try {
        const j = await httpJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:' + encodeURIComponent(doi) + '&format=json&resultType=core&pageSize=1');
        const hit = j && j.resultList && j.resultList.result && j.resultList.result[0];
        if (hit && hit.pmcid) pmcid = String(hit.pmcid);
      } catch (e) { /* skip */ }
    }
  }

  // Europe PMC render backend (biomedical OA; best-effort last resort — its REST fullTextPDF
  // endpoint is defunct, so target the render service that actually emits PDF bytes)
  if (pmcid) {
    const acc = 'PMC' + pmcid.replace(/^PMC/i, '');
    if (acc.length > 3) addCand(map, 'https://europepmc.org/backend/ptpmcrender.fcgi?accid=' + acc + '&blobtype=pdf', 'Europe PMC', PRIO.epmc);
  }

  return Array.from(map.values()).sort((a, b) => a.priority - b.priority).map(({ url, source }) => ({ url, source }));
}

// Discover, then download the first candidate whose bytes are a real PDF.
// Returns { ok:true, bytes, url, source } or { ok:false, tried:[...], firstUrl }.
export async function fetchOaPdf(ref, httpJson, httpBytes, opts = {}) {
  const candidates = await discoverOaPdfUrls(ref, httpJson, opts);
  const tried = [];
  for (const c of candidates) {
    tried.push(c.url);
    try {
      const bytes = await httpBytes(c.url);
      if (looksLikePdf(bytes)) return { ok: true, bytes, url: c.url, source: c.source };
    } catch (e) { /* try the next candidate */ }
  }
  return { ok: false, tried, firstUrl: candidates[0] ? candidates[0].url : null };
}
