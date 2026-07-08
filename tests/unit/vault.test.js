// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ulid, loadNotes, saveNotes, seedNotes, newNote,
  loadFolders, saveFolders, toMarkdown, corruptBackupKey,
} from '../../src/lib/vault.js';

beforeEach(() => localStorage.clear());

describe('ulid', () => {
  it('is a 26-char Crockford base32 string and unique across calls', () => {
    const a = ulid();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid()).not.toBe(a);
  });
});

describe('notes cache', () => {
  it('round-trips through localStorage', () => {
    const notes = [{ id: 'a', title: 'T', body: 'b' }];
    expect(saveNotes(notes)).toBe(true);
    expect(loadNotes()).toEqual(notes);
  });
  it('returns [] when nothing is stored', () => {
    expect(loadNotes()).toEqual([]);
  });
  it('backs up corrupt storage instead of overwriting it', () => {
    localStorage.setItem('arf-vault-v0', 'not valid json{');
    expect(loadNotes()).toEqual([]);
    const key = corruptBackupKey();
    expect(key).toMatch(/^arf-vault-v0-corrupt-/);
    expect(localStorage.getItem(key)).toBe('not valid json{');
  });
  it('treats a non-array payload as corrupt', () => {
    localStorage.setItem('arf-vault-v0', JSON.stringify({ not: 'an array' }));
    expect(loadNotes()).toEqual([]);
  });
});

describe('seedNotes / newNote', () => {
  it('seeds three starter notes with ids and timestamps', () => {
    const seeded = seedNotes();
    expect(seeded).toHaveLength(3);
    seeded.forEach((n) => {
      expect(n.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(n.folder).toBe('');
      expect(n.created).toBeTruthy();
    });
    expect(loadNotes()).toHaveLength(3);
  });
  it('newNote lands in the requested folder', () => {
    expect(newNote('Inbox').folder).toBe('Inbox');
  });
});

describe('folders cache', () => {
  it('round-trips and filters non-strings', () => {
    saveFolders(['a', 'b', '', null, 3]);
    expect(loadFolders()).toEqual(['a', 'b']);
  });
});

describe('toMarkdown', () => {
  it('emits frontmatter with id, quoted title, tags, and the body', () => {
    const md = toMarkdown({ id: 'X1', title: 'Title', tags: ['a', 'b'], created: 'c', updated: 'u', body: 'hello' });
    expect(md).toContain('id: X1');
    expect(md).toContain('title: "Title"');
    expect(md).toContain('tags: [a, b]');
    expect(md).toContain('hello');
  });
  it('sanitizes a comma inside a tag so re-import does not split it', () => {
    const md = toMarkdown({ id: 'X1', title: 'T', tags: ['a,b', 'c'], created: 'c', updated: 'u', body: '' });
    expect(md).toContain('tags: [a b, c]');
  });
});
