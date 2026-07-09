import { describe, it, expect } from 'vitest';
import { canonFolder, allFolderPaths, folderList, buildFolderRows, planFolderMove } from '../../src/lib/folders.js';

describe('canonFolder', () => {
  it('normalizes separators and trailing slash', () => {
    expect(canonFolder('a/b/')).toBe('a/b');
    expect(canonFolder('a\\b')).toBe('a/b');
  });
  it('drops . and .. segments so a folder can never escape the vault', () => {
    expect(canonFolder('./a/../b')).toBe('a/b');
  });
  it('mirrors Win32 name rules', () => {
    expect(canonFolder('CON')).toBe('CON-');
    expect(canonFolder('trailing. ')).toBe('trailing');
  });
});

describe('allFolderPaths', () => {
  it('materializes every ancestor of a nested path', () => {
    expect(allFolderPaths(['a/b/c'], []).sort()).toEqual(['a', 'a/b', 'a/b/c']);
  });
  it('ignores empty segments from a leading/double slash', () => {
    expect(allFolderPaths(['/a//b'], []).sort()).toEqual(['a', 'a/b']);
  });
});

describe('buildFolderRows', () => {
  const folders = ['Parent', 'Parent/Child'];
  const notes = [{ id: 'n1', title: 'Note', folder: 'Parent/Child' }];

  it('flattens the tree with depth, counts, and hasChildren', () => {
    const rows = buildFolderRows(folders, notes, {});
    expect(rows.map((r) => r.type)).toEqual(['folder', 'folder', 'note']);
    const parent = rows[0], child = rows[1];
    expect(parent.path).toBe('Parent');
    expect(parent.depth).toBe(0);
    expect(parent.hasChildren).toBe(true);
    expect(parent.count).toBe(0);
    expect(child.path).toBe('Parent/Child');
    expect(child.count).toBe(1);
  });
  it('hides descendants of a collapsed folder', () => {
    const rows = buildFolderRows(folders, notes, { Parent: true });
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe('Parent');
  });
  it('terminates on a self-referential leading-slash path', () => {
    expect(() => buildFolderRows(['/a'], [], {})).not.toThrow();
  });
  it('keeps alphabetical order when no explicit order is given (unchanged default)', () => {
    const ns = [{ id: 'b', title: 'Beta', folder: '' }, { id: 'a', title: 'Alpha', folder: '' }];
    const rows = buildFolderRows([], ns, {});
    expect(rows.map((r) => r.note.title)).toEqual(['Alpha', 'Beta']);
  });
  it('honors an explicit note order over the alphabetical fallback', () => {
    const ns = [{ id: 'a', title: 'Alpha', folder: '' }, { id: 'b', title: 'Beta', folder: '' }];
    const rows = buildFolderRows([], ns, {}, { notes: { a: 1, b: 0 }, folders: {} });
    expect(rows.map((r) => r.note.id)).toEqual(['b', 'a']);
  });
  it('honors an explicit folder order among siblings', () => {
    const rows = buildFolderRows(['A', 'B'], [], {}, { notes: {}, folders: { A: 1, B: 0 } });
    expect(rows.filter((r) => r.type === 'folder').map((r) => r.path)).toEqual(['B', 'A']);
  });
});

describe('planFolderMove', () => {
  it('refuses to move a folder into itself or a descendant (circular)', () => {
    expect(planFolderMove('a', 'a', ['a'], []).reason).toBe('circular');
    expect(planFolderMove('a', 'a/b', ['a', 'a/b'], []).reason).toBe('circular');
  });
  it('refuses a move onto a name already owned by an unrelated subtree (collision)', () => {
    const r = planFolderMove('a/x', 'b', ['a/x', 'b/x'], []);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('collision');
    expect(r.leaf).toBe('x');
  });
  it('promotes a subfolder to the root and reparents its notes', () => {
    const notes = [{ id: 'n1', folder: 'Concepts/Sub' }];
    const r = planFolderMove('Concepts/Sub', '', ['Concepts', 'Concepts/Sub'], notes);
    expect(r.ok).toBe(true);
    expect(r.newPath).toBe('Sub');
    expect(r.newFolders.sort()).toEqual(['Concepts', 'Sub']);
    expect(r.noteMoves).toEqual([{ id: 'n1', to: 'Sub' }]);
  });
  it('nests a folder and rewrites descendant paths', () => {
    const notes = [{ id: 'n1', folder: 'Sub/Deep' }];
    const r = planFolderMove('Sub', 'Concepts', ['Concepts', 'Sub', 'Sub/Deep'], notes);
    expect(r.ok).toBe(true);
    expect(r.newPath).toBe('Concepts/Sub');
    expect(r.newFolders.sort()).toEqual(['Concepts', 'Concepts/Sub', 'Concepts/Sub/Deep']);
    expect(r.noteMoves).toEqual([{ id: 'n1', to: 'Concepts/Sub/Deep' }]);
  });
});
