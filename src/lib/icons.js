// Arf line icons: 16x16 grid, 1.4 px strokes in currentColor, round caps and joins, no fills except
// small solid marks. Values are inner SVG markup; icon() wraps one in a decorative <svg>.
export const ICONS = {
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 13.8 13.8"/>',
  fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/><circle cx="8" cy="8" r="1.6"/>',
  'zoom-in': '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 13.8 13.8M5 7h4M7 5v4"/>',
  'zoom-out': '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 13.8 13.8M5 7h4"/>',
  pin: '<path d="M6 2.5h4M7 2.5v3.7L4.6 9h6.8L9 6.2V2.5M8 9v4.5"/>',
  unpin: '<path d="M6 2.5h4M7 2.5v3.7L4.6 9h6.8L9 6.2V2.5M8 9v4.5M2.5 2.5l11 11"/>',
  filter: '<path d="M2.5 3.5h11L9.2 8.6v4.2L6.8 11.6v-3z"/>',
  forces: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="5.5" cy="4.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="7" cy="11.5" r="1.4" fill="currentColor" stroke="none"/>',
  download: '<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13.2h10"/>',
  image: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.4"/><circle cx="5.8" cy="6.4" r="1.1"/><path d="M2.6 11.6 6.4 8.4l2.4 2 1.8-1.4 3 2.4"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  trash: '<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.7 8.9h6.2l.7-8.9M6.7 6.6v4.4M9.3 6.6v4.4"/>',
  check: '<path d="M3 8.4 6.4 11.6 13 4.6"/>',
  play: '<path d="M5 3.2v9.6L12.6 8z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.2"/>',
  globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.7 1.6 2.5 3.5 2.5 5.6S9.7 12 8 13.6C6.3 12 5.5 10.1 5.5 8S6.3 4 8 2.4z"/>',
  text: '<path d="M3 4V2.8h10V4M8 2.8v10.4M6.2 13.2h3.6"/>',
  chip: '<rect x="4" y="4" width="8" height="8" rx="1.2"/><rect x="6.4" y="6.4" width="3.2" height="3.2" rx=".4"/><path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v4"/><circle cx="8" cy="5" r=".55" fill="currentColor"/>',
  folder: '<path d="M2.2 4.2c0-.7.5-1.2 1.2-1.2h2.8l1.4 1.5h5c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
  import: '<path d="M8 2v7.6M5 6.8 8 9.8l3-3"/><path d="M2.6 9.6v3.6h10.8V9.6"/>',
  upload: '<path d="M8 10.4V2.6M5 5.4 8 2.4l3 3"/><path d="M2.6 9.6v3.6h10.8V9.6"/>',
  // model marks: the Arf serif A (feet serifs) with a linked node pair; the multilingual mark trades the link for a meridian globe
  arfllm: '<path d="M2.4 13.2 6 2.8l3.6 10.4M3.8 9.4h4.4M1.4 13.2h2.2M8.6 13.2h2.2M12.6 5.6v4.4"/><circle cx="12.6" cy="4.3" r="1.2"/><circle cx="12.6" cy="11.6" r="1.5" fill="currentColor" stroke="none"/>',
  'arfllm-multi': '<path d="M2.4 13.2 6 2.8l3.6 10.4M3.8 9.4h4.4M1.4 13.2h2.2M8.6 13.2h2.2"/><circle cx="12.4" cy="5.4" r="2.4"/><path d="M12.4 3c-1.3 1.3-1.3 3.5 0 4.8M10 5.4h4.8"/><circle cx="12.4" cy="11.6" r="1.5" fill="currentColor" stroke="none"/>',
  'model-add': '<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M8 6.2v3.6M6.2 8h3.6M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
};

export function icon(name, size = 16) {
  const body = ICONS[name];
  if (!body) return '';
  return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}
