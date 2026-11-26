// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { step, rove } from '../../src/lib/listnav.js';

describe('step', () => {
  it('moves down and up, wrapping at the ends', () => {
    expect(step(3, 0, 'ArrowDown')).toBe(1);
    expect(step(3, 2, 'ArrowDown')).toBe(0);
    expect(step(3, 0, 'ArrowUp')).toBe(2);
  });
  it('clamps instead of wrapping when asked', () => {
    expect(step(3, 2, 'ArrowDown', { wrap: false })).toBe(2);
    expect(step(3, 0, 'ArrowUp', { wrap: false })).toBe(0);
  });
  it('skips separators and disabled rows', () => {
    const skip = (i) => i === 1 || i === 2;
    expect(step(5, 0, 'ArrowDown', { skip })).toBe(3);
    expect(step(5, 3, 'ArrowUp', { skip })).toBe(0);
    expect(step(5, 0, 'End', { skip: (i) => i === 4 })).toBe(3);
    expect(step(5, 3, 'Home', { skip: (i) => i === 0 })).toBe(1);
  });
  it('enters the list from no selection at the matching end', () => {
    expect(step(4, -1, 'ArrowDown')).toBe(0);
    expect(step(4, -1, 'ArrowUp')).toBe(3);
  });
  it('returns -1 for an empty or fully disabled list', () => {
    expect(step(0, 0, 'ArrowDown')).toBe(-1);
    expect(step(3, 0, 'ArrowDown', { skip: () => true })).toBe(-1);
  });
  it('keeps the only selectable row', () => {
    expect(step(3, 1, 'ArrowDown', { skip: (i) => i !== 1 })).toBe(1);
  });
});

describe('rove', () => {
  it('moves focus between enabled buttons and ignores other keys', () => {
    document.body.innerHTML = '<div id="m"><button>a</button><button disabled>b</button><button>c</button></div>';
    const m = document.getElementById('m'), [a, , c] = m.querySelectorAll('button');
    a.focus();
    expect(rove(m, { key: 'ArrowDown' }, 'button')).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(rove(m, { key: 'ArrowDown' }, 'button')).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(rove(m, { key: 'Enter' }, 'button')).toBe(false);
  });
});
