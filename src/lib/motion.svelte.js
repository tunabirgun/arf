// Motion grammar for Arf (R2). One duration scale, honored against prefers-reduced-motion.
// Durations mirror the CSS --dur-* tokens in app.css — keep the two in lockstep.
//
// Svelte <-> CSS easing equivalence (Svelte transitions take an easing fn; CSS rules use the tokens):
//   quintOut  ~= --ease-out    cubic-bezier(.16, 1, .3, 1)   — enters/exits
//   cubicOut  ~= FLIP settle / accordion
//   expoOut   ~= strong ease-out for larger dialogs
// Reduced motion = movement removed, short fades kept: dur() collapses to 0, so a fade becomes an
// instant swap while a fly/slide has no distance. Callers pass opacity-only transitions through dur().
import { prefersReducedMotion } from 'svelte/motion';

export const DUR = { exit: 80, fast: 120, base: 200, slow: 260 };

// duration in ms, or 0 under reduced motion (an in:fade of 0 is an instant, flicker-free swap)
export function dur(ms) { return prefersReducedMotion.current ? 0 : ms; }
// travel distance in px, or 0 under reduced motion (a fly with dist 0 is a pure fade)
export function dist(px) { return prefersReducedMotion.current ? 0 : px; }
// the app's single velocity-preserving Spring (graph node-drag release) is disabled under reduced motion
export function springEnabled() { return !prefersReducedMotion.current; }
