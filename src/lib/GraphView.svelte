<script>
  import { onMount, untrack } from 'svelte';
  import { buildGraph, bfs, subgraph, listFolders, listTags, searchNodes } from './graph/model.js';
  import { createEngine } from './graph/engine.js';
  import { DEFAULT_FORCES, FORCE_RANGES } from './graph/sim.js';
  import { icon } from './icons.js';
  import { dur } from './motion.svelte.js';

  // suggest: [{a, b, s}] unlinked pairs (Resonance) drawn as dashed connection edges.
  // onselect(ids) reports the multi-selection; onexport({name, type, blob}) overrides the browser download.
  // probe: harness-only hook that receives the engine's measurement API.
  let { notes, idx, centerId = null, mode = 'ego', onopen, onselect = null, suggest = null, onexport = null, probe = null } = $props();
  const full = untrack(() => mode) === 'full';   // the view kind is fixed for a mounted instance
  const FORCE_KEY = 'arf-graph-forces-v1';
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const MOD = IS_MAC ? '⌘' : 'Ctrl';

  let stage, canvas, listEl;
  let engine = null;
  let graph = { nodes: [], links: [] };   // plain object; never a $state proxy

  let q = $state(''), depth = $state('all'), tag = $state(''), folder = $state('');
  let hideOrphans = $state(false), showSuggested = $state(true), forcesOpen = $state(false);
  let forces = $state.raw(loadForces());
  let items = $state.raw([]);              // [{id, title}] for the screen-reader list
  let focusId = $state(null), announce = $state(''), matchIds = $state.raw([]);
  let counts = $state.raw({ nodes: 0, links: 0 }), selCount = $state(0), note = $state(''), startNode = $state(null);
  const rovingId = $derived(focusId || startNode);
  const reduce = $derived(dur(1) === 0);
  let helpShown = $state(true);            // the gesture hint goes after the first interaction with the stage (wheel is caught in capture: d3-zoom stops its propagation)
  const hideHelp = () => { if (helpShown) helpShown = false; };

  const centerOk = $derived(!!(centerId && idx && idx.byId[centerId]));
  const folders = $derived(full ? listFolders(notes) : []);
  const tags = $derived(full && idx ? listTags(idx) : []);
  const hasSuggest = $derived(Array.isArray(suggest) && suggest.length > 0);
  const empty = $derived(
    full ? (!notes.length ? 'none' : counts.nodes === 0 ? 'filtered' : '')
      : (!centerOk ? 'nocenter' : counts.nodes <= 1 ? 'isolated' : ''));

  function loadForces() {
    try { const v = JSON.parse(localStorage.getItem(FORCE_KEY) || 'null'); if (v && typeof v === 'object') return { ...DEFAULT_FORCES, ...v }; } catch (e) {}
    return { ...DEFAULT_FORCES };
  }

  function rebuild(refit = false) {
    if (!engine || !idx) return;
    last = { idx, suggest, sig: [tag, folder, hideOrphans, depth].join('|'), center: centerId };
    if (!full) {
      if (!centerOk) graph = { nodes: [], links: [] };
      else {
        const ids = new Set([centerId, ...(idx.fwd[centerId] || []), ...(idx.back[centerId] || [])]);
        const sug = hasSuggest ? suggest.filter((p) => p.a === centerId || p.b === centerId) : null;
        if (sug) for (const p of sug) { ids.add(p.a); ids.add(p.b); }
        graph = buildGraph(notes, idx, { only: ids, suggest: sug });
      }
    } else {
      graph = buildGraph(notes, idx, { tag, folder, hideOrphans, suggest: hasSuggest ? suggest : null });
      if (depth !== 'all' && centerOk && graph.nodes.some((n) => n.id === centerId)) graph = subgraph(graph, bfs(graph.nodes, graph.links, centerId, +depth));
    }
    engine.setData(graph, { centerId: centerOk ? centerId : null, refit });
    counts = { nodes: graph.nodes.length, links: graph.links.filter((l) => l.kind !== 'suggested').length };
    if (focusId && !graph.nodes.some((n) => n.id === focusId)) focusId = null;
    selCount = engine.selected.length;
    startNode = startId();
    applySearch();
    // the hidden list can be thousands of buttons: build it after the first frame is on screen
    cancelList();
    const snapshot = graph;
    listRaf = requestAnimationFrame(() => {
      listRaf = 0;
      listTimer = setTimeout(() => {
        listTimer = 0;
        items = snapshot.nodes.map((n) => ({ id: n.id, title: n.title })).sort((a, b) => a.title.localeCompare(b.title));
      }, 0);
    });
  }
  let listRaf = 0, listTimer = 0;
  function cancelList() { cancelAnimationFrame(listRaf); clearTimeout(listTimer); listRaf = listTimer = 0; }

  function applySearch() {
    if (!engine || !full) return;
    const hits = q.trim() ? searchNodes(graph.nodes, q) : [];
    matchIds = hits.map((n) => n.id);
    engine.setMatches(matchIds);
  }

  onMount(() => {
    // harness hook: App mounts GraphView without a probe, so e2e specs opt in through a window flag
    const hook = probe || (typeof window !== 'undefined' && typeof window.__arfGraphProbe === 'function' ? (e) => window.__arfGraphProbe(e, full ? 'full' : 'ego') : null);
    engine = createEngine(canvas, {
      mode: full ? 'full' : 'ego', host: stage, storage: localStorage,
      reduced: () => dur(1) === 0,
      onopen: (id) => onopen && onopen(id),
      onselect: (ids) => { selCount = ids.length; if (onselect) onselect(ids); },
      onpin: (id, pinned) => { const i = engine.info(id); if (i) announce = i.title + (pinned ? ', pinned' : ', unpinned'); },
      probe: hook,
    });
    engine.setForces(forces);
    engine.setShowSuggested(showSuggested);
    rebuild(false);
    if (hook) hook(engine);
    return () => { cancelList(); engine.destroy(); engine = null; };
  });

  // Rebuild on index, suggestion, filter or (ego / depth lens) centre changes. App rebuilds idx on a
  // debounce after edits, so identity is the signal. In the full view without a depth lens a centre
  // change only restyles the current-note marker.
  let last = { idx: null, suggest: null, sig: null, center: null };
  $effect(() => {
    const sig = [tag, folder, hideOrphans, depth].join('|');
    const cur = { idx, suggest, sig, center: centerId };
    untrack(() => {
      if (!engine) return;
      const filters = last.sig !== null && cur.sig !== last.sig;
      const lens = full && depth !== 'all' && cur.center !== last.center;
      if (!full ? (cur.idx !== last.idx || cur.suggest !== last.suggest || cur.center !== last.center) : (filters || lens || cur.idx !== last.idx || cur.suggest !== last.suggest)) rebuild(full && (filters || lens));
      else engine.setCenter(centerOk ? centerId : null);
    });
  });
  $effect(() => { q; untrack(applySearch); });
  $effect(() => { const v = showSuggested; untrack(() => engine && engine.setShowSuggested(v)); });

  function setForce(key, value) {
    forces = { ...forces, [key]: +value };
    engine && engine.setForces(forces);
    try { localStorage.setItem(FORCE_KEY, JSON.stringify(forces)); } catch (e) {}
  }
  function resetForces() {
    forces = { ...DEFAULT_FORCES };
    engine && engine.setForces(forces);
    try { localStorage.removeItem(FORCE_KEY); } catch (e) {}
  }

  function onSearchKey(e) {
    if (e.key === 'Enter' && matchIds.length) {
      e.preventDefault();
      engine.zoomToNode(matchIds[0]);
      setFocus(matchIds[0], false);
    } else if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); q = ''; }
  }

  function setFocus(id, moveDom = true) {
    focusId = id;
    engine.setFocus(id);
    const i = engine.info(id);
    if (i) announce = i.title + ', ' + i.links + (i.links === 1 ? ' link' : ' links') + (i.pinned ? ', pinned' : '');
    if (moveDom && listEl) {
      const el = listEl.querySelector('[data-nid="' + CSS.escape(id) + '"]');
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    }
  }
  function startId() {
    if (centerOk && graph.nodes.some((n) => n.id === centerId)) return centerId;
    let best = null; for (const n of graph.nodes) if (!best || n.degree > best.degree) best = n;
    return best ? best.id : null;
  }
  const DIRS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  function onStageKey(e) {
    if (!engine || e.target.closest('input, select, textarea')) return;
    const k = e.key;
    let done = true;
    if (DIRS[k]) {
      const cur = focusId || startId();
      if (!cur) return;
      const next = focusId ? engine.neighbourInDirection(cur, ...DIRS[k]) : cur;
      if (next) setFocus(next); else announce = 'No linked note in that direction';
    } else if ((k === 'p' || k === 'P') && focusId && !e.ctrlKey && !e.metaKey) { engine.togglePin(focusId); const i = engine.info(focusId); announce = i.title + (i.pinned ? ', pinned' : ', unpinned'); }
    else if (full && (k === '+' || k === '=')) engine.zoomBy(1.5);
    else if (full && (k === '-' || k === '_')) engine.zoomBy(1 / 1.5);
    else if (full && k === '0') engine.fit();
    else if (k === 'Escape') {
      // clear what can be cleared; with nothing to clear the key falls through and App closes the overlay
      const cleared = engine.clearSelection();
      if (cleared) announce = 'Selection cleared';
      else if (focusId) { focusId = null; engine.setFocus(null); }
      else done = false;
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }

  async function exportView(kind) {
    if (!engine) return;
    const name = 'arf-graph.' + kind;
    const blob = kind === 'png' ? await engine.exportPNG() : new Blob([engine.exportSVG()], { type: 'image/svg+xml' });
    if (!blob) { note = 'Export failed.'; return; }
    if (onexport) { await onexport({ name, type: blob.type, blob }); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function unpinAll() { const c = engine ? engine.unpinAll() : 0; announce = c ? 'Unpinned ' + c + (c === 1 ? ' note' : ' notes') : 'No pinned notes'; }

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function wrapFocus(e) {
    const guard = e.currentTarget;
    const dlg = guard.closest('[aria-modal="true"], .overlay');
    if (!dlg) return;
    const all = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el !== guard && el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length);
    if (!all.length) return;
    // arriving from inside the dialog means a forward Tab: wrap to the start; otherwise (Shift+Tab wrapping
    // in from outside) land on the last real control
    const fwd = e.relatedTarget && dlg.contains(e.relatedTarget);
    (fwd ? all[0] : all[all.length - 1]).focus();
  }

  const FORCE_LABELS = { repel: 'Repel', linkDistance: 'Link distance', linkForce: 'Link force', center: 'Centre' };
</script>

<div class="gv" class:full class:ego={!full}>
  {#if full}
    <div class="gbar" role="toolbar" aria-label="Graph controls">
      <label class="gsearch">
        <span class="gi">{@html icon('search', 14)}</span>
        <input type="search" placeholder="Find a note" aria-label="Find a note in the graph" bind:value={q} onkeydown={onSearchKey} />
        {#if q.trim()}<span class="gcount" aria-live="polite">{matchIds.length}</span>{/if}
      </label>
      <div class="gseg" role="group" aria-label="Depth around the current note">
        {#each ['all', '1', '2', '3'] as d}
          <button aria-pressed={depth === d} class:on={depth === d} disabled={d !== 'all' && !centerOk}
            title={d === 'all' ? 'Whole vault' : d + (d === '1' ? ' link' : ' links') + ' from the current note'}
            onclick={() => (depth = d)}>{d === 'all' ? 'All' : d}</button>
        {/each}
      </div>
      <label class="gsel" title="Filter by tag"><span class="gi">{@html icon('filter', 14)}</span>
        <select bind:value={tag} aria-label="Filter by tag">
          <option value="">All tags</option>
          {#each tags as t}<option value={t}>#{t}</option>{/each}
        </select>
      </label>
      <label class="gsel" title="Filter by folder"><span class="gi">{@html icon('folder', 14)}</span>
        <select bind:value={folder} aria-label="Filter by folder">
          <option value="">All folders</option>
          {#each folders as f}<option value={f}>{f}</option>{/each}
        </select>
      </label>
      <label class="gchk"><input type="checkbox" bind:checked={hideOrphans} /> Hide unlinked</label>
      <label class="gchk" class:off={!hasSuggest} title={hasSuggest ? 'Dashed edges: similar notes not linked yet' : 'No suggestions for this vault yet'}>
        <input type="checkbox" bind:checked={showSuggested} disabled={!hasSuggest} /> Suggested links</label>
      <span class="gsp"></span>
      <span class="gstat">{counts.nodes.toLocaleString()} {counts.nodes === 1 ? 'note' : 'notes'} · {counts.links.toLocaleString()} {counts.links === 1 ? 'link' : 'links'}{#if selCount} · {selCount} selected{/if}</span>
      <button class="gb" class:on={forcesOpen} aria-expanded={forcesOpen} aria-controls="gforces" title="Forces" onclick={() => (forcesOpen = !forcesOpen)}>{@html icon('forces')}<span>Forces</span></button>
      <button class="gb ic" title="Zoom out (-)" aria-label="Zoom out" onclick={() => engine.zoomBy(1 / 1.5)}>{@html icon('zoom-out')}</button>
      <button class="gb ic" title="Zoom in (+)" aria-label="Zoom in" onclick={() => engine.zoomBy(1.5)}>{@html icon('zoom-in')}</button>
      <button class="gb ic" title="Fit to view (0)" aria-label="Fit to view" onclick={() => engine.fit()}>{@html icon('fit')}</button>
      <button class="gb ic" title="Unpin all" aria-label="Unpin all notes" onclick={unpinAll}>{@html icon('unpin')}</button>
      <button class="gb ic" title="Export view as PNG" aria-label="Export view as PNG" onclick={() => exportView('png')}>{@html icon('image')}</button>
      <button class="gb ic" title="Export view as SVG" aria-label="Export view as SVG" onclick={() => exportView('svg')}>{@html icon('download')}</button>
    </div>
    {#if forcesOpen}
      <div class="gforces" id="gforces" role="group" aria-label="Forces">
        {#each Object.keys(FORCE_LABELS) as key}
          <label class="gf"><span>{FORCE_LABELS[key]}</span>
            <input type="range" min={FORCE_RANGES[key][0]} max={FORCE_RANGES[key][1]} step={FORCE_RANGES[key][2]} value={forces[key]}
              oninput={(e) => setForce(key, e.currentTarget.value)} />
            <output>{key === 'linkForce' || key === 'center' ? forces[key].toFixed(2) : forces[key]}</output>
          </label>
        {/each}
        <button class="gb" onclick={resetForces}>Reset</button>
      </div>
    {/if}
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="gstage" bind:this={stage} tabindex="-1" onkeydown={(e) => { hideHelp(); onStageKey(e); }} onwheelcapture={hideHelp}
    onpointerdown={() => { hideHelp(); if (document.activeElement !== stage && !stage.contains(document.activeElement)) stage.focus({ preventScroll: true }); }}
    class:hidden={empty === 'nocenter' || empty === 'none' || empty === 'filtered'}>
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <ul class="gsr" bind:this={listEl} aria-label={full ? 'Notes in the graph' : 'Notes linked to this note'}>
      {#each items as it (it.id)}
        <li><button data-nid={it.id} tabindex={rovingId === it.id ? 0 : -1}
          onfocus={() => { if (focusId !== it.id) setFocus(it.id, false); }}
          onclick={() => onopen && onopen(it.id)}>{it.title}</button></li>
      {/each}
    </ul>
    {#if empty === 'isolated'}<div class="gcap">No links yet</div>{/if}
  </div>
  {#if full && !empty && helpShown}
    <div class="ghelp">{reduce ? 'Drag a note to move it' : 'Drag a note to pull its links'} · Shift-release or double-click to pin · {MOD}-click to select · arrows move between links</div>
  {/if}
  {#if empty === 'nocenter'}<div class="gempty">No note open.</div>
  {:else if empty === 'none'}<div class="gempty center">No notes yet. Notes you link with [[ ]] appear here.</div>
  {:else if empty === 'filtered'}<div class="gempty center">No notes match these filters.</div>{/if}
  {#if note}<div class="gempty">{note}</div>{/if}
  <div class="gsr" aria-live="polite">{announce}</div>
  {#if full}
    <!-- focus guard: the overlay's last tab stop is in this view; Tab past it wraps to the dialog's first
         control instead of escaping to <body> -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <span class="gguard" tabindex="0" onfocus={wrapFocus}></span>
  {/if}
</div>

<style>
  .gv { position: relative; font-family: var(--sans); }
  .gv.ego { margin-top: .3rem; }
  .gv.full { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .gstage { position: relative; }
  .gv.ego .gstage { height: 220px; }
  .gv.full .gstage { flex: 1; min-height: 0; }
  .gstage.hidden { height: 0 !important; flex: 0 0 0; overflow: hidden; }
  .gstage:focus { outline: none; }
  .gstage:focus-within:has(:focus-visible) { outline: 2px solid var(--fg-faint); outline-offset: -2px; border-radius: var(--r-s); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
  .gv.full canvas { cursor: grab; }
  .gv.full canvas:active { cursor: grabbing; }

  .gsr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; list-style: none; }
  .gempty { font-size: 13px; color: var(--fg-muted); font-style: italic; }
  .gempty.center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; text-align: center; }
  .gcap { position: absolute; left: 0; right: 0; bottom: .4rem; text-align: center; font-size: 12px; font-style: italic; color: var(--fg-muted); pointer-events: none; }
  .ghelp { flex: none; padding: .35rem .9rem .5rem; font-size: 11px; color: var(--fg-muted); border-top: 1px solid var(--rule-1); }
  .gguard { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  .gbar { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .55rem; padding: .5rem 1.1rem; border-bottom: 1px solid var(--rule-1); font-size: 12px; color: var(--fg-muted); }
  .gi { display: inline-flex; color: var(--fg-faint); }
  .gsearch { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--line-strong); border-radius: var(--r-s); padding: 0 .45rem; height: 28px; background: var(--surface-1); }
  .gsearch input { border: 0; background: none; outline: none; font: inherit; font-size: 12.5px; color: var(--fg); width: 13rem; }
  .gsearch:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
  .gcount { font-family: var(--mono); font-size: 11px; color: var(--fg-muted); }
  .gseg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r-s); overflow: hidden; }
  .gseg button { background: none; border: 0; padding: 0 .55rem; height: 26px; font: inherit; font-size: 11.5px; color: var(--fg-muted); cursor: pointer; transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
  .gseg button + button { border-left: 1px solid var(--line-strong); }
  .gseg button.on { background: var(--surface-3); color: var(--fg-bright); box-shadow: inset 0 -2px 0 var(--fg-muted); }
  .gseg button:disabled { color: var(--fg-faint); opacity: .55; cursor: default; }
  .gsel { display: inline-flex; align-items: center; gap: .3rem; }
  .gsel select { font: inherit; font-size: 12px; color: var(--fg); background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: var(--r-s); height: 28px; padding: 0 .3rem; max-width: 11rem; }
  .gchk { display: inline-flex; align-items: center; gap: .3rem; cursor: pointer; white-space: nowrap; }
  .gchk input { accent-color: var(--fg-muted); }
  .gchk.off { color: var(--fg-faint); cursor: default; }
  .gsp { flex: 1; }
  .gstat { font-size: 11.5px; color: var(--fg-muted); white-space: nowrap; }
  .gb { display: inline-flex; align-items: center; gap: .35rem; height: 28px; padding: 0 .55rem; background: none; border: 1px solid var(--line-strong); border-radius: var(--r-s); color: var(--fg-muted); font: inherit; font-size: 12px; cursor: pointer; transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out); }
  .gb.ic { width: 28px; padding: 0; justify-content: center; }
  .gb:hover { color: var(--fg-bright); border-color: var(--fg-faint); }
  .gb.on { color: var(--fg-bright); background: var(--surface-3); }
  .gb:focus-visible, .gseg button:focus-visible, .gsel select:focus-visible, .gchk input:focus-visible, .gf input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .gforces { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.4rem; padding: .5rem 1.1rem; border-bottom: 1px solid var(--rule-1); font-size: 12px; color: var(--fg-muted); }
  .gf { display: inline-flex; align-items: center; gap: .5rem; }
  .gf input { width: 8.5rem; accent-color: var(--fg-muted); }
  .gf output { font-family: var(--mono); font-size: 11px; color: var(--fg-muted); min-width: 2.6em; }
  @media (prefers-reduced-motion: reduce) { .gb, .gseg button { transition: none; } }
</style>
