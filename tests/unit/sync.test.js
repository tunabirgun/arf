import { describe, it, expect } from 'vitest';
import { mergeByUpdated, syncChanged, conflictDecision, fullReadGate } from '../../src/lib/sync.js';

describe('mergeByUpdated', () => {
  it('keeps the strictly-newer copy of a note', () => {
    const out = mergeByUpdated(
      [{ id: 'a', updated: '2020-01-01', body: 'old' }],
      [{ id: 'a', updated: '2020-01-02', body: 'new' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('new');
  });
  it('ignores an older incoming copy', () => {
    const out = mergeByUpdated(
      [{ id: 'a', updated: '2020-01-02', body: 'keep' }],
      [{ id: 'a', updated: '2020-01-01', body: 'stale' }],
    );
    expect(out[0].body).toBe('keep');
  });
  it('lets an equal-timestamp hand-edit (different body) win', () => {
    const out = mergeByUpdated(
      [{ id: 'a', updated: 't', body: 'old' }],
      [{ id: 'a', updated: 't', body: 'edited' }],
    );
    expect(out[0].body).toBe('edited');
  });
  it('does not replace on an identical equal-timestamp copy', () => {
    const base = [{ id: 'a', updated: 't', body: 'same', title: 'T', folder: '', tags: [] }];
    const out = mergeByUpdated(base, [{ id: 'a', updated: 't', body: 'same', title: 'T', folder: '', tags: [] }]);
    expect(out[0].body).toBe('same');
  });
  it('adds a note present only in incoming', () => {
    const out = mergeByUpdated([{ id: 'a', updated: 't' }], [{ id: 'b', updated: 't' }]);
    expect(out.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
});

describe('syncChanged', () => {
  const A = [{ id: 'a', updated: 't', body: 'x', title: 'T', folder: '', tags: [] }];
  it('is false for structurally identical sets', () => {
    expect(syncChanged(A, [{ id: 'a', updated: 't', body: 'x', title: 'T', folder: '', tags: [] }])).toBe(false);
  });
  it('is true when a note is added or removed', () => {
    expect(syncChanged(A, [...A, { id: 'b', updated: 't', body: '' }])).toBe(true);
  });
  it('is true when a body changes under the same timestamp', () => {
    expect(syncChanged(A, [{ id: 'a', updated: 't', body: 'y', title: 'T', folder: '', tags: [] }])).toBe(true);
  });
});

describe('conflictDecision', () => {
  const local = { id: 'a', updated: '2020-01-01', body: 'local' };
  it('flags a conflict when the remote body differs and is strictly newer', () => {
    const { conflict, key } = conflictDecision(local, { id: 'a', updated: '2020-01-02', body: 'remote' }, new Set());
    expect(conflict).toBe(true);
    expect(key).toBe('a@2020-01-02');
  });
  it('does NOT flag when the remote is not strictly newer (phantom-conflict guard)', () => {
    // a self-flush round-trips `updated` byte-for-byte — equal timestamps must never conflict
    expect(conflictDecision(local, { id: 'a', updated: '2020-01-01', body: 'remote' }, new Set()).conflict).toBe(false);
  });
  it('does NOT flag when the body is unchanged', () => {
    expect(conflictDecision(local, { id: 'a', updated: '2020-01-02', body: 'local' }, new Set()).conflict).toBe(false);
  });
  it('does NOT re-flag a remote version already stashed', () => {
    const seen = new Set(['a@2020-01-02']);
    expect(conflictDecision(local, { id: 'a', updated: '2020-01-02', body: 'remote' }, seen).conflict).toBe(false);
  });
  it('is inert when either side is missing', () => {
    expect(conflictDecision(local, null, new Set())).toEqual({ conflict: false, key: null });
    expect(conflictDecision(null, { id: 'a', updated: 't' }, new Set())).toEqual({ conflict: false, key: null });
  });
});

describe('fullReadGate (focus + visibilitychange coalescing)', () => {
  it('a full request during a full tick does not schedule another full read', () => {
    const g = fullReadGate();
    g.request();                       // focus
    expect(g.begin()).toBe(true);      // the tick takes it: a full read
    g.request();                       // visibilitychange, same regain, while that read is in flight
    g.end(true);
    expect(g.begin()).toBe(false);     // the next tick is incremental
    g.end(true);
  });
  it('a full request during an incremental tick still runs a full read next', () => {
    const g = fullReadGate();
    expect(g.begin()).toBe(false);
    g.request();
    g.end(true);
    expect(g.begin()).toBe(true);
    g.end(true);
    expect(g.begin()).toBe(false);
  });
  it('a failed full tick asks again', () => {
    const g = fullReadGate();
    g.request(); expect(g.begin()).toBe(true);
    g.end(false);
    expect(g.begin()).toBe(true);
  });
  it('a request with no tick running waits for the next tick', () => {
    const g = fullReadGate();
    g.request(); g.request();
    expect(g.begin()).toBe(true); g.end(true);
    expect(g.begin()).toBe(false);
  });
});
