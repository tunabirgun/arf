// Arrow-key movement over a list of rows (palette results, pickers, the context menu).
// skip(i) marks rows that cannot be active (separators, disabled items). Returns the new index,
// or -1 when no row is selectable.
export const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

export function step(n, cur, key, { skip = () => false, wrap = true } = {}) {
  if (!(n > 0)) return -1;
  const ok = (i) => !skip(i);
  const first = () => { for (let i = 0; i < n; i++) if (ok(i)) return i; return -1; };
  const last = () => { for (let i = n - 1; i >= 0; i--) if (ok(i)) return i; return -1; };
  if (key === 'Home') return first();
  if (key === 'End') return last();
  const d = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!d) return cur >= 0 && cur < n && ok(cur) ? cur : first();
  if (cur < 0 || cur >= n) return d > 0 ? first() : last();
  for (let k = 1; k <= n; k++) {
    let i = cur + d * k;
    if (i < 0 || i >= n) { if (!wrap) return ok(cur) ? cur : -1; i = (i + n) % n; }
    if (ok(i)) return i;
  }
  return ok(cur) ? cur : -1;
}

// roving focus inside a container: moves DOM focus between its enabled `sel` elements.
// Returns true when the key was handled (the caller then prevents the default).
export function rove(container, e, sel) {
  if (!container || !NAV_KEYS.includes(e.key)) return false;
  const items = [...container.querySelectorAll(sel)];
  const at = items.indexOf(document.activeElement);
  const next = step(items.length, at, e.key, { skip: (i) => items[i].disabled || items[i].getAttribute('aria-disabled') === 'true' });
  if (next < 0) return false;
  items[next].focus();
  if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' });
  return true;
}
