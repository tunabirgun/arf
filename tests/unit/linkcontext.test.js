import { describe, it, expect } from 'vitest';
import { linkContext, previewText, stripInline } from '../../src/lib/linkcontext.js';
import { seedNotes } from '../../src/lib/vault.js';

const text = (c) => (c ? c.before + '[' + c.match + ']' + c.after : null);

describe('linkContext', () => {
  it('returns the sentence around the link with the link text separated', () => {
    const c = linkContext('First sentence. We rely on [[Entropy]] for this. Last one.', 'Entropy');
    expect(c).toEqual({ before: 'We rely on ', match: 'Entropy', after: ' for this.' });
  });
  it('matches the target case-insensitively and shows the alias', () => {
    expect(text(linkContext('See [[entropy|the second law]] here.', 'Entropy'))).toBe('See [the second law] here.');
  });
  it('ignores links in fenced and inline code', () => {
    const body = '```\n[[Entropy]] in a fence\n```\nInline `[[Entropy]]` too.\n\nReal [[Entropy]] link.';
    expect(text(linkContext(body, 'Entropy'))).toBe('Real [Entropy] link.');
    expect(linkContext('~~~\n[[Entropy]]\n~~~', 'Entropy')).toBeNull();
  });
  it('takes the first of several occurrences', () => {
    expect(text(linkContext('One [[A]] here.\nTwo [[A]] there.', 'a'))).toBe('One [A] here.');
  });
  it('strips Markdown from the surrounding text and list/heading/quote markers', () => {
    expect(text(linkContext('- [ ] **Read** [the paper](http://x) on [[A]] and ![img](i.png) [[B|bee]] `code` [@smith2020].', 'A')))
      .toBe('Read the paper on [A] and bee code smith2020.');
    expect(text(linkContext('## About [[A]]', 'A'))).toBe('About [A]');
    expect(text(linkContext('> quoted [[A]] text', 'A'))).toBe('quoted [A] text');
  });
  it('keeps markup characters as text (rendering escapes them)', () => {
    const c = linkContext('Tags <b>x</b> & 1 < 2 near [[A]].', 'A');
    expect(c.before).toBe('Tags x & 1 < 2 near ');
  });
  it('trims long context to about max characters with ellipses, keeping the match whole', () => {
    const long = 'word '.repeat(60) + '[[Target note]] ' + 'more '.repeat(60) + 'end.';
    const c = linkContext(long, 'Target note', { max: 140 });
    expect(c.match).toBe('Target note');
    expect(c.before.startsWith('…')).toBe(true);
    expect(c.after.endsWith('…')).toBe(true);
    expect((c.before + c.match + c.after).length).toBeLessThanOrEqual(142);
  });
  it('returns null when the note does not link the title', () => {
    expect(linkContext('No links here.', 'A')).toBeNull();
    expect(linkContext('[[Ab]] only', 'A')).toBeNull();
    expect(linkContext('', 'A')).toBeNull();
  });
  it('finds the seed note backlink, skipping the later one in backticks', () => {
    const seed = seedNotes().find((s) => s.title === 'Link your thoughts');
    const c = linkContext(seed.body, 'Welcome to Arf');
    expect(c.match).toBe('Welcome to Arf');
    expect(c.before).toContain('double brackets');
  });
});

describe('previewText', () => {
  it('drops images, block markers and inline marks, keeps code text', () => {
    expect(previewText('# Title\n\n![x](a.png)\n\n- **bold** item with [[Note|alias]]\n\n```js\nconst a = 1;\n```')).toBe('Title bold item with alias const a = 1;');
  });
  it('cuts at max on a word boundary with an ellipsis', () => {
    const p = previewText('alpha '.repeat(100), 50);
    expect(p.length).toBeLessThanOrEqual(50);
    expect(p.endsWith('…')).toBe(true);
    expect(p).not.toMatch(/alph…$/);
  });
  it('skips rules, table separators and math fences', () => {
    expect(previewText('a\n\n---\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n$$\nE=mc^2\n$$')).toBe('a x y 1 2 E=mc^2');
  });
  it('is empty for an empty note', () => { expect(previewText('')).toBe(''); });
});

describe('stripInline', () => {
  it('leaves intra-word underscores alone', () => { expect(stripInline('snake_case_name and _em_')).toBe('snake_case_name and em'); });
});
