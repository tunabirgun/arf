// The interface ships in English only. This is a pass-through so the t() call sites
// across the UI keep working; there is no language selection.
export function t(en) { return en; }
