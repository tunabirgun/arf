// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadRefs, saveRefs } from '../../src/lib/references.js';

beforeEach(() => localStorage.clear());

describe('reference library', () => {
  it('round-trips through localStorage', () => {
    const refs = [{ id: 'r1', citekey: 'a2020', authors: [{ f: 'A', g: 'B' }] }];
    expect(saveRefs(refs)).toBe(true);
    expect(loadRefs()).toEqual(refs);
  });

  it('repairs a missing authors array', () => {
    localStorage.setItem('arf-refs-v0', JSON.stringify([{ id: 'r1', citekey: 'x' }]));
    expect(loadRefs()[0].authors).toEqual([]);
  });

  it('drops a null/non-object author entry so downstream formatting cannot crash', () => {
    localStorage.setItem('arf-refs-v0', JSON.stringify([{ id: 'r1', authors: [null, 'x', { f: 'Y', g: 'Z' }] }]));
    const authors = loadRefs()[0].authors;
    expect(authors).toEqual([{ f: 'Y', g: 'Z' }]);
  });

  it('defaults missing name parts on an author object', () => {
    localStorage.setItem('arf-refs-v0', JSON.stringify([{ id: 'r1', authors: [{ f: 'Only' }] }]));
    expect(loadRefs()[0].authors[0]).toEqual({ f: 'Only', g: '' });
  });

  it('ignores a corrupt payload', () => {
    localStorage.setItem('arf-refs-v0', 'not json{');
    expect(loadRefs()).toEqual([]);
  });
});
