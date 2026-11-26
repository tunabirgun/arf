import { describe, it, expect, vi } from 'vitest';
import { TauriBackend, parse } from '../../src/lib/vaultadapter.js';
import { mergeByUpdated, syncChanged, reconnectMerge, adoptDiskStamps } from '../../src/lib/sync.js';

const ROOT = '/vault';
const fm = (id, title, updated, body = 'body') =>
  `---\nid: ${id}\ntitle: "${title}"\ntags: [a, b]\ncreated: 2020-01-01T00:00:00.000Z\nupdated: ${updated}\n---\n\n${body}\n`;

// In-memory vault: rel -> { text, mtime }. fs mimics plugin-fs (readDir entries, readTextFile by absolute path).
function mkVault(init) {
  const files = new Map(Object.entries(init).map(([rel, v]) => [rel, { text: v.text ?? v, mtime: v.mtime ?? 1000 }]));
  const reads = [];
  let inFlight = 0, peak = 0;
  const fs = {
    async readDir(dir) {
      const prefix = dir === ROOT ? '' : dir.slice(ROOT.length + 1) + '/';
      const seen = new Map();
      for (const rel of files.keys()) {
        if (!rel.startsWith(prefix)) continue;
        const rest = rel.slice(prefix.length), i = rest.indexOf('/');
        seen.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
      }
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
    },
    async readTextFile(abs) {
      const rel = abs.slice(ROOT.length + 1);
      reads.push(rel);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (!files.has(rel)) throw new Error('ENOENT');
      return files.get(rel).text;
    },
  };
  // independent restatement of the Rust walk rules
  const v = {
    files, reads, fs, get peak() { return peak; },
    scan: () => [...files]
      .filter(([rel]) => {
        const parts = rel.split('/');
        return rel.endsWith('.md') && !parts.some((p) => p.startsWith('.')) && parts[0] !== 'attachments';
      })
      .map(([rel, f]) => ({ rel, mtime: f.mtime, size: f.text.length })),
    set(rel, text, mtime) { files.set(rel, { text, mtime }); },
  };
  return v;
}
function mkBackend(v, { scanFails = false } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (scanFails) throw new Error('command vault_scan not found');
    return v.scan();
  };
  return { b: new TauriBackend(ROOT, v.fs, { invoke }), calls };
}
const byId = (notes) => Object.fromEntries(notes.map((n) => [n.id, n]));
const U1 = '2020-02-01T00:00:00.000Z';
const NOTE_PATHS = ['a.md', 'plain.md', 'sub/attachments/keep.md', 'sub/b.md', 'sub/deep/c.md'];

const fixture = () => ({
  'a.md': fm('A', 'Alpha', U1),
  'sub/b.md': fm('B', 'Beta', U1),
  'sub/deep/c.md': fm('C', 'Gamma', U1),
  'plain.md': '# Plain\n\nno frontmatter\n',
  '.hidden.md': fm('H', 'Hidden', U1),
  '.git/x.md': fm('G', 'Git', U1),
  'attachments/ref.md': fm('R', 'Ref', U1),
  'sub/attachments/keep.md': fm('K', 'Keep', U1),
  'readme.txt': 'not a note',
  'UPPER.MD': fm('U', 'Upper', U1),
});

// the pre-optimisation loadAll, kept as the reference for the fallback path
async function oldLoadAll(b) {
  const notes = [];
  const walk = async (dir, prefix) => {
    let entries = []; try { entries = await b.fs.readDir(dir); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!prefix && e.isDirectory && e.name === 'attachments') continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory) await walk(b.join(dir, e.name), rel);
      else if (e.name.endsWith('.md')) {
        try {
          const text = await b.fs.readTextFile(b.join(dir, e.name));
          const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          const note = parse(text, { folder, fallbackId: rel, fallbackTitle: e.name.replace(/\.md$/, '') });
          note._path = rel; notes.push(note);
        } catch (err) { /* skip */ }
      }
    }
  };
  await walk(b.root, '');
  const m = new Map();
  for (const n of notes) { const ex = m.get(n.id); if (!ex || (n.updated || '') > (ex.updated || '')) m.set(n.id, n); }
  return [...m.values()];
}

describe('TauriBackend.loadAll via vault_scan', () => {
  it('one invoke per call; second call reads only changed files', async () => {
    const v = mkVault(fixture());
    const { b, calls } = mkBackend(v);
    const first = await b.loadAll();
    expect(calls).toEqual([['vault_scan', { root: ROOT }]]);
    const expected = v.scan().length;
    expect(first).toHaveLength(expected);
    expect(v.reads).toHaveLength(expected);
    v.reads.length = 0;
    v.set('a.md', fm('A', 'Alpha edited', U1, 'longer body text'), 2000);
    const second = await b.loadAll();
    expect(calls).toHaveLength(2);
    expect(v.reads).toEqual(['a.md']);
    expect(byId(second).A.title).toBe('Alpha edited');
    expect(byId(second).B.title).toBe('Beta');
  });

  it('reuses the parse when mtime and size are equal', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    await b.loadAll(); v.reads.length = 0;
    await b.loadAll();
    expect(v.reads).toEqual([]);
  });

  it('re-reads a file whose size changed even at the same mtime', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    await b.loadAll(); v.reads.length = 0;
    v.set('a.md', fm('A', 'Alpha', U1, 'now a different length body'), 1000);
    const notes = await b.loadAll();
    expect(v.reads).toEqual(['a.md']);
    expect(byId(notes).A.body).toContain('different length');
  });

  it('re-reads a file whose mtime changed at the same size', async () => {
    const v = mkVault({ 'a.md': fm('A', 'Alpha', U1, 'aaaa') });
    const { b } = mkBackend(v);
    await b.loadAll(); v.reads.length = 0;
    v.set('a.md', fm('A', 'Alpha', U1, 'bbbb'), 1001);
    expect((await b.loadAll())[0].body).toContain('bbbb');
    expect(v.reads).toEqual(['a.md']);
  });

  it('drops a deleted file and reads a new one', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    await b.loadAll(); v.reads.length = 0;
    v.files.delete('sub/b.md');
    v.set('new.md', fm('N', 'New', U1), 3000);
    const notes = await b.loadAll();
    expect(byId(notes).B).toBeUndefined();
    expect(byId(notes).N.title).toBe('New');
    expect(v.reads).toEqual(['new.md']);
  });

  it('opts.full re-reads everything', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    await b.loadAll();
    const n = v.reads.length; v.reads.length = 0;
    await b.loadAll({ full: true });
    expect(v.reads).toHaveLength(n);
  });

  it('every 15th call re-reads everything', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    const n = v.scan().length;
    for (let i = 1; i <= 16; i++) {
      v.reads.length = 0;
      await b.loadAll();
      expect(v.reads).toHaveLength(i === 1 || i === 15 ? n : 0);
    }
  });

  it('returns copies, never the cached objects', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    const first = await b.loadAll();
    byId(first).A.title = 'mutated'; byId(first).A.tags.push('zzz'); byId(first).A.body = 'x';
    const second = await b.loadAll();               // served from the cache
    expect(byId(second).A.title).toBe('Alpha');
    expect(byId(second).A.tags).toEqual(['a', 'b']);
    expect(byId(second).A).not.toBe(byId(first).A);
    expect(byId(second).A.tags).not.toBe(byId(first).A.tags);
    expect(byId(second).A.body).toContain('body');
  });

  it('excludes root attachments/ and dot files but keeps nested attachments/', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    expect((await b.loadAll()).map((n) => n._path).sort()).toEqual(NOTE_PATHS);
  });

  it('applies folder, fallbackId, fallbackTitle and _path from the rel path', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    const notes = await b.loadAll();
    const plain = notes.find((n) => n._path === 'plain.md');
    expect([plain.id, plain.title, plain.folder]).toEqual(['plain.md', 'plain', '']);
    expect(notes.find((n) => n._path === 'sub/deep/c.md').folder).toBe('sub/deep');
  });

  it('skips an unreadable file and does not cache it', async () => {
    const v = mkVault(fixture());
    const { b } = mkBackend(v);
    const scan = v.scan;
    v.scan = () => [...scan(), { rel: 'ghost.md', mtime: 5, size: 5 }];  // listed but unreadable
    const notes = await b.loadAll();
    expect(notes.find((n) => n._path === 'ghost.md')).toBeUndefined();
    v.files.set('ghost.md', { text: fm('Z', 'Ghost', U1), mtime: 5 });
    v.scan = scan;
    expect(byId(await b.loadAll()).Z.title).toBe('Ghost');
  });

  it('bounds read concurrency', async () => {
    const init = {};
    for (let i = 0; i < 60; i++) init[`n${i}.md`] = fm('id' + i, 'T' + i, U1);
    const v = mkVault(init);
    const { b } = mkBackend(v);
    expect(await b.loadAll()).toHaveLength(60);
    expect(v.peak).toBeGreaterThan(1);
    expect(v.peak).toBeLessThanOrEqual(16);
  });
});

describe('TauriBackend.loadAll fallback walk', () => {
  it('gives the same notes as the old walk when invoke throws', async () => {
    const v = mkVault(fixture());
    const { b, calls } = mkBackend(v, { scanFails: true });
    const got = await b.loadAll();
    expect(calls).toHaveLength(1);
    const ref = await oldLoadAll(new TauriBackend(ROOT, v.fs));
    const sorted = (ns) => [...ns].sort((x, y) => x._path.localeCompare(y._path));
    // frontmatter-less files differ only in the fallback timestamps (old: now, new: stable stamp) and
    // the _stamped flag that marks them
    const strip = (ns) => sorted(ns).map(({ created, updated, _stamped, ...n }) => n);
    expect(strip(got)).toEqual(strip(ref));
    expect(got.filter((n) => n._stamped).map((n) => n._path)).toEqual(['plain.md']);
    expect(got.map((n) => n._path)).toEqual(ref.map((n) => n._path));   // same order, so dedupe ties resolve alike
    for (const n of got.filter((n) => n.id !== n._path)) {
      const r = ref.find((x) => x._path === n._path);
      expect([n.created, n.updated]).toEqual([r.created, r.updated]);
    }
  });

  it('falls back when invoke returns something that is not a list', async () => {
    const v = mkVault(fixture());
    const b = new TauriBackend(ROOT, v.fs, { invoke: async () => null });
    expect((await b.loadAll()).map((n) => n._path).sort()).toEqual(NOTE_PATHS);
  });

  it('reads in a bounded pool and re-reads each call (no cache without mtime)', async () => {
    const init = {};
    for (let i = 0; i < 40; i++) init[`d${i % 4}/n${i}.md`] = fm('id' + i, 'T' + i, U1);
    const v = mkVault(init);
    const { b } = mkBackend(v, { scanFails: true });
    expect(await b.loadAll()).toHaveLength(40);
    expect(v.peak).toBeGreaterThan(1);
    expect(v.peak).toBeLessThanOrEqual(16);
    expect(v.reads).toHaveLength(40);
    await b.loadAll();
    expect(v.reads).toHaveLength(80);
  });
});

describe('stable fallback timestamps (F1)', () => {
  const T1 = Date.parse('2024-03-01T10:00:00.000Z'), T2 = Date.parse('2024-03-02T10:00:00.000Z');
  const modes = {
    'scan with mtime': (v) => mkBackend(v).b,
    'memo (scan without mtime)': (v) => new TauriBackend(ROOT, v.fs, { invoke: async () => v.scan().map((e) => ({ ...e, mtime: 0 })) }),
    'memo (fallback walk)': (v) => mkBackend(v, { scanFails: true }).b,
  };
  for (const [mode, make] of Object.entries(modes)) {
    it(`keeps created/updated while unchanged and moves them forward after an edit: ${mode}`, async () => {
      const v = mkVault({ 'plain.md': { text: 'first body\n', mtime: T1 } });
      const b = make(v);
      const n1 = (await b.loadAll())[0];
      await new Promise((r) => setTimeout(r, 5));
      const n2 = (await b.loadAll({ full: true }))[0];
      expect([n2.created, n2.updated]).toEqual([n1.created, n1.updated]);
      if (mode === 'scan with mtime') expect(n1.updated).toBe(new Date(T1).toISOString());
      await new Promise((r) => setTimeout(r, 5));
      v.set('plain.md', 'second, edited body\n', T2);
      const n3 = (await b.loadAll())[0];
      expect(n3.updated > n1.updated).toBe(true);
      expect(n3.body).toContain('edited');
      expect((await b.loadAll({ full: true }))[0].updated).toBe(n3.updated);
    });
  }

  it('a memo entry for a removed file is dropped, so a re-created file gets a fresh stamp', async () => {
    const v = mkVault({ 'p.md': { text: 'x\n', mtime: 0 } });
    const { b } = mkBackend(v, { scanFails: true });
    const t1 = (await b.loadAll())[0].updated;
    v.files.delete('p.md'); await b.loadAll();
    await new Promise((r) => setTimeout(r, 5));
    v.set('p.md', 'x\n', 0);
    expect((await b.loadAll())[0].updated > t1).toBe(true);
  });

  for (const scanFails of [false, true]) {
    it(`mergeByUpdated + syncChanged see no change across ticks for an unchanged frontmatter-less file (${scanFails ? 'fallback' : 'scan'})`, async () => {
      const v = mkVault({ 'plain.md': { text: '# Plain\n\nNo frontmatter.\n', mtime: 1700000000000 }, 'a.md': fm('A', 'Alpha', U1) });
      const { b } = mkBackend(v, { scanFails });
      let notes = await b.loadAll();
      for (let tick = 0; tick < 3; tick++) {
        await new Promise((r) => setTimeout(r, 5));
        const merged = mergeByUpdated(notes, await b.loadAll());
        expect(syncChanged(notes, merged)).toBe(false);
        notes = merged;
      }
    });
  }

  it('a real edit of the frontmatter-less file is still detected by the sync merge', async () => {
    const v = mkVault({ 'plain.md': { text: 'one\n', mtime: 1700000000000 } });
    const { b } = mkBackend(v);
    const notes = await b.loadAll();
    v.set('plain.md', 'two, longer\n', 1700000005000);
    const merged = mergeByUpdated(notes, await b.loadAll());
    expect(syncChanged(notes, merged)).toBe(true);
    expect(merged[0].body).toContain('two');
  });
});

// ---- upgrade from 2.0.0: a frontmatter-less file whose cached copy carries a newer "now" stamp ----
describe('stamped disk notes at reconnect and sync (2.0.0 upgrade)', () => {
  const MT = Date.parse('2023-05-01T08:00:00.000Z');
  const NOW_STAMP = '2026-11-20T12:00:00.000Z';   // what 2.0.0 persisted: the load time, newer than the mtime
  const setup = async (scanFails = false) => {
    const v = mkVault({ 'Inbox/idea.md': { text: '# Idea\n\nplain text, no frontmatter\n', mtime: MT }, 'a.md': fm('A', 'Alpha', U1) });
    const { b } = mkBackend(v, { scanFails });
    const writes = [];
    b.fs.writeTextFile = async (abs, text) => { writes.push(abs); };
    b.fs.mkdir = async () => {};
    b.fs.exists = async () => false;
    b.fs.remove = async () => {};
    const ex = await b.loadAll();
    // the 2.0.0 cache copy: the same parse of the same file, but stamped with the load time
    const disk = ex.find((n) => n.id === 'Inbox/idea.md');
    const cached = [{ id: disk.id, title: disk.title, folder: disk.folder, tags: [], body: disk.body, created: NOW_STAMP, updated: NOW_STAMP, _path: disk._path },
      { ...ex.find((n) => n.id === 'A'), _stamped: undefined }];
    return { v, b, ex, cached, writes };
  };
  const flush = async (b, notes, dirtyIds) => { for (const id of dirtyIds) await b.saveNote(notes.find((n) => n.id === id)); };

  for (const scanFails of [false, true]) {
    it(`identical content with a newer cached now-stamp: adopts the disk timestamps and writes nothing (${scanFails ? 'fallback: its first-seen stamp is newer anyway' : 'scan: fails without adoptDiskStamps'})`, async () => {
      const { b, ex, cached, writes } = await setup(scanFails);
      expect(ex.find((n) => n.id === 'Inbox/idea.md')._stamped).toBe(true);
      expect(ex.find((n) => n.id === 'A')._stamped).toBeUndefined();
      const { notes, dirty } = reconnectMerge(cached, ex, new Set());
      expect(dirty).toEqual([]);
      await flush(b, notes, dirty);
      expect(writes).toEqual([]);
      const idea = notes.find((n) => n.id === 'Inbox/idea.md');
      expect(idea.updated).toBe(ex.find((n) => n.id === 'Inbox/idea.md').updated);
      expect(idea._path).toBe('Inbox/idea.md');
      // and the next sync tick sees nothing to change
      const disk2 = await b.loadAll();
      expect(syncChanged(notes, mergeByUpdated(adoptDiskStamps(notes, disk2), disk2))).toBe(false);
    });
  }

  it('a real cached edit of such a note still writes', async () => {
    const { b, ex, cached, writes } = await setup();
    cached[0].body += '\nedited before a hard quit\n';
    const { notes, dirty } = reconnectMerge(cached, ex, new Set());
    expect(dirty).toEqual(['Inbox/idea.md']);
    expect(notes.find((n) => n.id === 'Inbox/idea.md').body).toContain('edited before');
    await flush(b, notes, dirty);
    expect(writes).toHaveLength(1);
  });

  it('a cached copy differing only in title, tags or folder is a real edit too', () => {
    for (const change of [{ title: 'Renamed' }, { tags: ['x'] }, { folder: 'Other' }]) {
      const disk = [{ id: 'p.md', title: 'p', folder: '', tags: [], body: 'b', created: 'T0', updated: 'T0', _path: 'p.md', _stamped: true }];
      const local = [{ ...disk[0], _stamped: undefined, created: 'T9', updated: 'T9', ...change }];
      expect(adoptDiskStamps(local, disk)[0]).toBe(local[0]);
      expect(reconnectMerge(local, disk, new Set()).dirty).toEqual(['p.md']);
    }
  });

  it('syncFromFolder adoption: only stamped disk copies with identical content donate their timestamps', () => {
    const disk = [
      { id: 's', title: 's', folder: '', tags: [], body: 'same', created: 'T1', updated: 'T1', _path: 's.md', _stamped: true },
      { id: 'f', title: 'f', folder: '', tags: [], body: 'same', created: 'T1', updated: 'T1', _path: 'f.md' },
    ];
    const local = [{ ...disk[0], _stamped: undefined, created: 'T5', updated: 'T5' }, { ...disk[1], created: 'T5', updated: 'T5' }];
    const out = adoptDiskStamps(local, disk);
    expect(out[0]).toMatchObject({ created: 'T1', updated: 'T1', _flushed: 'T1', _path: 's.md' });
    expect(out[0]._stamped).toBeUndefined();
    expect(out[1]).toBe(local[1]);   // frontmatter timestamps are real: the newer local copy stays newer
  });
});

describe('same-size edits inside one mtime tick (item 8)', () => {
  const T = Date.parse('2026-06-01T12:00:00.000Z');
  it('re-reads a file whose mtime is within 3 s of now, even with mtime and size unchanged', async () => {
    let now = T + 500;
    const v = mkVault({ 'a.md': { text: fm('A', 'Alpha', U1, 'body one'), mtime: T }, 'old.md': { text: fm('O', 'Old', U1), mtime: T - 60000 } });
    const b = new TauriBackend(ROOT, v.fs, { invoke: async () => v.scan(), now: () => now });
    await b.loadAll(); v.reads.length = 0;
    // an external same-size edit in the same filesystem tick (FAT/exFAT 2 s, NTFS ms)
    v.set('a.md', fm('A', 'Alpha', U1, 'body two'), T);
    now = T + 1900;
    const notes = await b.loadAll();
    expect(v.reads).toEqual(['a.md']);              // the old file still comes from the cache
    expect(byId(notes).A.body).toContain('body two');
    now = T + 3500; v.reads.length = 0;
    await b.loadAll();
    expect(v.reads).toEqual([]);                    // settled: cached again
  });
  it('treats an mtime in the future (clock skew) within 3 s as recent too', async () => {
    const v = mkVault({ 'a.md': { text: fm('A', 'Alpha', U1), mtime: T + 2000 } });
    const b = new TauriBackend(ROOT, v.fs, { invoke: async () => v.scan(), now: () => T });
    await b.loadAll(); v.reads.length = 0;
    await b.loadAll();
    expect(v.reads).toEqual(['a.md']);
  });
});

describe('vault_scan failure is observable (item 4)', () => {
  it('warns once per backend, not once per tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = mkVault(fixture());
    const { b } = mkBackend(v, { scanFails: true });
    await b.loadAll(); await b.loadAll(); await b.loadAll();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/vault_scan/);
    const { b: b2 } = mkBackend(v, { scanFails: true });
    await b2.loadAll();
    expect(warn).toHaveBeenCalledTimes(2);
    const { b: ok } = mkBackend(v);
    await ok.loadAll();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
