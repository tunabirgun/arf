// Confirm a destructive action. In the desktop app, tauri-plugin-dialog 2.7's window.confirm shim invokes a command
// the plugin no longer registers (plugin:dialog|confirm), so it always rejects; use the plugin's ask() instead, which
// goes through the allowed `message` command with Yes/No buttons. The web build uses the browser's confirm.
const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

export async function confirmAsk(message, { okLabel = 'Delete', cancelLabel = 'Cancel', ask = null } = {}) {
  try {
    if (isTauri || ask) {
      const fn = ask || (await import('@tauri-apps/plugin-dialog')).ask;
      return !!(await fn(message, { title: 'Arf', kind: 'warning', okLabel, cancelLabel }));
    }
    const r = window.confirm(message);
    return !!(r && typeof r.then === 'function' ? await r : r);
  } catch (e) { return false; }
}
