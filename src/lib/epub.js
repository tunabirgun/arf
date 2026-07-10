// EPUB → readable, selectable HTML for the side reader.
//
// An EPUB is a ZIP of XHTML documents. We read the OPF (via META-INF/container.xml), follow the
// spine in reading order, sanitize each chapter's body, inline its images as data URIs (so the
// self-contained reader shows them without a file server), and concatenate. The result renders
// inline like the rest of the reader, so quoting and highlighting work the same as for a PDF.

import { unzipSync, strFromU8 } from 'fflate';
import DOMPurify from 'dompurify';

const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };

// resolve an href against a base directory, collapsing ./ and ../ and dropping any #fragment/?query.
// pure string logic — unit-tested.
export function resolveHref(baseDir, href) {
  const clean = String(href || '').replace(/[?#].*$/, '');
  if (!clean) return '';
  const fromRoot = clean.startsWith('/');                                  // a leading '/' is the zip root, not baseDir-relative
  const parts = (fromRoot ? [] : (baseDir ? baseDir.split('/') : [])).concat(clean.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}
// directory portion of a zip path ('OEBPS/text/ch1.xhtml' → 'OEBPS/text')
export function dirOf(path) { const i = String(path).lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }

// the OPF path from container.xml — pure, unit-tested
export function opfPathFromContainer(xml) {
  const m = String(xml || '').match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function u8ToBase64(bytes) { let bin = ''; const c = 0x8000; for (let i = 0; i < bytes.length; i += c) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + c)); return btoa(bin); }

// Parse the OPF for manifest (id → href) and the spine reading order (list of hrefs).
function parseOpf(opfXml, opfDir) {
  const doc = new DOMParser().parseFromString(opfXml, 'application/xml');
  const idToHref = new Map();
  for (const item of doc.querySelectorAll('manifest > item')) {
    const id = item.getAttribute('id'); const href = item.getAttribute('href');
    if (id && href) idToHref.set(id, resolveHref(opfDir, href));
  }
  const spine = [];
  for (const it of doc.querySelectorAll('spine > itemref')) {
    const idref = it.getAttribute('idref');
    if (idref && idToHref.has(idref)) spine.push(idToHref.get(idref));
  }
  return spine;
}

// Extract an EPUB (Uint8Array) into one sanitized HTML string. Throws on a structural problem.
export function extractEpub(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const get = (p) => files[p] || files[p.replace(/^\//, '')];
  const containerRaw = get('META-INF/container.xml');
  if (!containerRaw) throw new Error('no container.xml');
  const opfPath = opfPathFromContainer(strFromU8(containerRaw));
  const opfRaw = get(opfPath);
  if (!opfRaw) throw new Error('no OPF');
  const opfDir = dirOf(opfPath);
  const spine = parseOpf(strFromU8(opfRaw), opfDir);
  if (!spine.length) throw new Error('empty spine');

  const parser = new DOMParser();
  const chapters = [];
  for (const href of spine) {
    const raw = get(href); if (!raw) continue;
    const chapDir = dirOf(href);
    let doc;
    try { doc = parser.parseFromString(strFromU8(raw), 'application/xhtml+xml'); } catch (e) { continue; }
    if (!doc || doc.querySelector('parsererror')) { try { doc = parser.parseFromString(strFromU8(raw), 'text/html'); } catch (e) { continue; } }
    const body = doc.body || doc.querySelector('body');
    if (!body) continue;
    // inline images referenced within this chapter, resolved against the chapter's directory
    for (const img of body.querySelectorAll('img, image')) {
      const attr = img.hasAttribute('src') ? 'src' : (img.hasAttribute('xlink:href') ? 'xlink:href' : (img.hasAttribute('href') ? 'href' : null));
      if (!attr) continue;
      const src = img.getAttribute(attr) || '';
      if (/^(data:|https?:)/i.test(src)) continue;
      const p = resolveHref(chapDir, src); const data = get(p);
      if (data) { const ext = (p.split('.').pop() || '').toLowerCase(); img.setAttribute('src', 'data:' + (IMG_MIME[ext] || 'application/octet-stream') + ';base64,' + u8ToBase64(data)); }
      else img.removeAttribute(attr);
    }
    chapters.push(DOMPurify.sanitize(body.innerHTML, { USE_PROFILES: { html: true } }));
  }
  if (!chapters.length) throw new Error('no readable chapters');
  return chapters.join('\n<hr class="epub-sep"/>\n');
}
