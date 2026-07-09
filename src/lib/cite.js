// Citation/reference formatters, shared by the Library (export) and the in-note
// bibliography. One reference object -> a formatted string in the chosen style.

export const CITE_STYLES = ['APA', 'Nature', 'BibTeX', 'RIS (EndNote)', 'CSL-JSON', 'Zenodo'];
// prose styles suitable for a rendered end-of-note reference list; the machine formats
// (BibTeX/RIS/CSL-JSON/Zenodo) are multi-line/JSON and only belong in the Library export modal
export const BIB_STYLES = ['APA', 'Nature'];

function initials(g) { return g ? g.split(/\s+/).filter(Boolean).map((x) => x[0] + '.').join(' ') : ''; }
export function shortAuth(a) { if (!Array.isArray(a) || !a.length) return ''; return a.length === 1 ? a[0].f : a.length === 2 ? a[0].f + ' & ' + a[1].f : a[0].f + ' et al.'; }

function bibType(t) { return t === 'book' ? 'book' : t === 'preprint' ? 'misc' : (t === 'webpage' || t === 'article-magazine') ? 'online' : 'article'; }
// escape the backslash FIRST (to a text-mode command with no braces of its own, so the later
// brace rule can't re-escape it), then the remaining LaTeX specials — otherwise a title with a
// literal '\' (e.g. "$\alpha$-decay") emits BibTeX that won't compile.
function escBib(s) { return String(s == null ? '' : s).replace(/\\/g, '\\textbackslash ').replace(/([%&#_${}])/g, '\\$1').replace(/\^/g, '\\^{}').replace(/~/g, '\\~{}'); }
function toBibTeX(r) { const f = []; if (r.authors && r.authors.length) f.push('  author = {' + r.authors.map((a) => escBib(a.f) + ', ' + escBib(a.g)).join(' and ') + '}'); f.push('  title = {' + escBib(r.title) + '}'); f.push('  year = {' + r.year + '}'); if (r.container) f.push('  ' + (r.type === 'book' ? 'publisher' : 'journal') + ' = {' + escBib(r.container) + '}'); if (r.publisher && !r.container) f.push('  publisher = {' + escBib(r.publisher) + '}'); if (r.volume) f.push('  volume = {' + r.volume + '}'); if (r.pages) f.push('  pages = {' + String(r.pages).replace(/[–—-]+/g, '--') + '}'); if (r.doi) f.push('  doi = {' + escBib(r.doi) + '}'); if (r.isbn) f.push('  isbn = {' + escBib(r.isbn) + '}'); if (r.url) f.push('  url = {' + escBib(r.archived || r.url) + '}'); return '@' + bibType(r.type) + '{' + r.citekey + ',\n' + f.join(',\n') + '\n}'; }
function risType(t) { return t === 'book' ? 'BOOK' : t === 'webpage' ? 'ELEC' : t === 'article-magazine' ? 'MGZN' : t === 'preprint' ? 'GEN' : 'JOUR'; }
// RIS is line-structured (one "XX  - value" per line), so any embedded newline in a free-text
// field would produce an orphan line with no tag and break the record — collapse CR/LF to a space.
function toRIS(r) { const rv = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' '); const L = ['TY  - ' + risType(r.type)]; (r.authors || []).forEach((a) => L.push('AU  - ' + rv(a.f) + ', ' + rv(a.g))); L.push('TI  - ' + rv(r.title)); L.push('PY  - ' + r.year); if (r.container) L.push((r.type === 'book' ? 'PB  - ' : 'JO  - ') + rv(r.container)); if (r.publisher && r.type === 'book') L.push('PB  - ' + rv(r.publisher)); if (r.volume) L.push('VL  - ' + r.volume); if (r.pages) { const p = String(r.pages).split(/[–-]/); L.push('SP  - ' + p[0]); if (p[1]) L.push('EP  - ' + p[1]); } if (r.doi) L.push('DO  - ' + r.doi); if (r.isbn) L.push('SN  - ' + r.isbn); if (r.url) L.push('UR  - ' + (r.archived || r.url)); if (r.accessed) L.push('Y2  - ' + r.accessed); L.push('ER  - '); return L.join('\n'); }
function toCSL(r) { const o = { id: r.citekey, type: r.type, title: r.title, author: (r.authors || []).map((a) => ({ family: a.f, given: a.g })) }; if (r.year) o.issued = { 'date-parts': [[r.year]] }; if (r.container) o['container-title'] = r.container; if (r.publisher) o.publisher = r.publisher; if (r.volume) o.volume = r.volume; if (r.pages) o.page = r.pages; if (r.doi) o.DOI = r.doi; if (r.isbn) o.ISBN = r.isbn; if (r.url) o.URL = r.archived || r.url; return '  ' + JSON.stringify(o); }
function apaAuth(as) { if (!as || !as.length) return ''; const s = as.map((a) => a.f + ', ' + initials(a.g)); return s.length > 1 ? s.slice(0, -1).join(', ') + ', & ' + s[s.length - 1] : s[0]; }
function toAPA(r) { const au = apaAuth(r.authors); let s = (au ? au + ' ' : '') + '(' + r.year + '). ' + r.title + '.'; if (r.container) s += ' ' + r.container + (r.volume ? ', ' + r.volume : '') + (r.pages ? ', ' + r.pages : '') + '.'; else if (r.publisher) s += ' ' + r.publisher + '.'; if (r.doi) s += ' https://doi.org/' + r.doi; else if (r.url) s += ' Retrieved ' + (r.accessed || '') + ', from ' + (r.archived || r.url); return s; }
function toNature(r) { const a = (r.authors || []).map((x) => x.f + ', ' + initials(x.g)).join(', '); let s = (a ? a + ' ' : '') + r.title + '.'; if (r.container) s += ' ' + r.container + (r.volume ? ' ' + r.volume : '') + (r.pages ? ', ' + r.pages : '') + ' (' + r.year + ').'; else s += ' (' + (r.publisher || '') + ', ' + r.year + ').'; return s; }
function zenType(t) { return t === 'book' ? 'book' : t === 'preprint' ? 'preprint' : (t === 'webpage' || t === 'article-magazine') ? 'other' : 'article'; }
function toZenodo(r) { const m = { upload_type: 'publication', publication_type: zenType(r.type), title: r.title, creators: (r.authors || []).map((a) => ({ name: a.f + ', ' + a.g })), description: r.abstract || r.title }; if (r.year) m.publication_date = r.year + '-01-01'; if (r.doi) m.doi = r.doi; if (r.container && r.type !== 'book') m.journal_title = r.container; if (r.publisher || r.type === 'book') m.imprint_publisher = r.publisher || r.container; return '  ' + JSON.stringify(m); }

const FORMATTERS = { 'BibTeX': toBibTeX, 'RIS (EndNote)': toRIS, 'CSL-JSON': toCSL, 'APA': toAPA, 'Nature': toNature, 'Zenodo': toZenodo };
export function formatRef(r, style) { return (FORMATTERS[style] || toAPA)(r); }
// join a list for a copy/export blob (JSON styles need array brackets)
export function joinRefs(list, style) {
  const j = (style === 'CSL-JSON' || style === 'Zenodo') ? ',\n' : '\n\n';
  let t = list.map((r) => formatRef(r, style)).join(j);
  if (style === 'CSL-JSON' || style === 'Zenodo') t = '[\n' + t + '\n]';
  return t;
}
