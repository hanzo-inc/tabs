/**
 * A terminal layout, as a value.
 *
 * A tiled workspace is a TREE, not a list of rectangles. The list is the shape
 * that looks easier — every pane carries x/y/width/height — and then it cannot
 * answer the one question that matters: close a pane, and who gets the space?
 * With boxes you are left recomputing every neighbour and hoping the arithmetic
 * closes. With a tree the answer is structural and exact: a pane's space belongs
 * to its sibling, so closing it replaces the parent split WITH that sibling and
 * nothing else moves.
 *
 * That is the whole reason for this file. Every operation here is a pure rewrite
 * of one tree into another, so the interesting behaviour — split, close, resize,
 * the order you sweep through panes in — is decided and tested without a browser,
 * a layout engine, or a single pixel.
 *
 * `row` puts children side by side (the divider is vertical, it moves left/right).
 * `col` stacks them (the divider is horizontal, it moves up/down). Those are the
 * CSS flex-direction words, chosen so the renderer passes the value straight
 * through rather than translating a private vocabulary into the platform's.
 */

export type Dir = 'row' | 'col';

export type Tile =
  | { kind: 'pane'; id: string }
  /** `ratio` is the fraction of the axis given to `a` (0..1). */
  | { kind: 'split'; dir: Dir; ratio: number; a: Tile; b: Tile };

/** Which branch to take at each split, from the root. `[]` is the root itself. */
export type Path = ReadonlyArray<'a' | 'b'>;

/** A layout of one pane. */
export const pane = (id: string): Tile => ({ kind: 'pane', id });

/** How far a divider may be dragged, as a fraction of its axis.
 *
 * A pane squeezed to nothing is not a layout choice, it is a pane you can no
 * longer find or drag back — so the split keeps a floor at both ends and a
 * closed pane is the only way to reach zero. */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

export const clampRatio = (r: number): number =>
  Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5;

/** Every pane id, left-to-right and top-to-bottom.
 *
 * This IS the sweep order — the sequence ⌥→ / ⌥← move through, and the order the
 * roster lists. It falls out of the tree rather than being tracked beside it,
 * which is why moving a pane cannot desynchronise the two. */
export function paneIds(t: Tile): string[] {
  return t.kind === 'pane' ? [t.id] : [...paneIds(t.a), ...paneIds(t.b)];
}

export const hasPane = (t: Tile, id: string): boolean => paneIds(t).includes(id);

/** The pane after `id` in sweep order, wrapping. `step` of -1 goes back. */
export function neighbour(t: Tile, id: string, step: 1 | -1): string | null {
  const ids = paneIds(t);
  const i = ids.indexOf(id);
  if (i < 0 || ids.length === 0) return ids[0] ?? null;
  return ids[(i + step + ids.length) % ids.length]!;
}

/** Split the pane showing `targetId`, putting `newId` in the fresh half.
 *
 * The new pane takes the SECOND half so a split reads the way it is drawn: the
 * thing you split stays where it was, and the new one appears to its right or
 * below. A `targetId` no pane shows leaves the tree untouched — a split has to
 * name where it happens, and inventing a location would put a terminal somewhere
 * nobody asked for.
 */
export function splitPane(t: Tile, targetId: string, dir: Dir, newId: string): Tile {
  if (t.kind === 'pane') {
    return t.id === targetId
      ? { kind: 'split', dir, ratio: 0.5, a: t, b: pane(newId) }
      : t;
  }
  return {
    ...t,
    a: splitPane(t.a, targetId, dir, newId),
    b: splitPane(t.b, targetId, dir, newId),
  };
}

/** How many members a run of `dir` splits holds. A pane, or a split the other
 *  way, is one member: it is a box in that run, whatever is inside it. */
const members = (t: Tile, dir: Dir): number =>
  t.kind === 'split' && t.dir === dir ? members(t.a, dir) + members(t.b, dir) : 1;

/** Give every member of the root's level an equal share of its axis.
 *
 * A level is the run of splits that share the root's direction: three columns
 * are a split of one against a split of two, and nothing in the tree says they
 * are one row except that both splits are `row`. Equal shares are therefore a
 * ratio per split, each the fraction of the run's members on its `a` side, and
 * the tree keeps its shape — only ratios change, so no pane moves in the DOM.
 * A member that is itself split the other way keeps its inside as it was.
 */
export function balance(t: Tile): Tile {
  if (t.kind === 'pane') return t;
  const dir = t.dir;
  const walk = (n: Tile): Tile => {
    if (n.kind !== 'split' || n.dir !== dir) return n;
    const a = members(n.a, dir);
    return { ...n, ratio: a / (a + members(n.b, dir)), a: walk(n.a), b: walk(n.b) };
  };
  return walk(t);
}

/** Add `newId` as a new column at the end of the top level, and even the level.
 *
 * This is what New does, as against a split. A split divides the one pane it
 * was asked of; New adds to the workspace, so the workspace makes room evenly —
 * halving whichever pane happened to be last gave the third terminal a quarter
 * of the screen. A layout stacked at the root becomes one column of the two.
 *
 * The column goes in at the far end of the run, so each seam divides one column
 * from the ones after it: dragging the last seam moves the last two columns and
 * leaves the others where they are.
 */
export function append(t: Tile | null, newId: string): Tile {
  if (!t) return pane(newId);
  const end = (n: Tile): Tile =>
    n.kind === 'split' && n.dir === 'row'
      ? { ...n, b: end(n.b) }
      : { kind: 'split', dir: 'row', ratio: 0.5, a: n, b: pane(newId) };
  return balance(end(t));
}

/** Remove a pane. Its sibling takes the space, which is what a tree is for.
 *
 * Returns `null` when the last pane goes — an empty layout is a real state (no
 * terminals to show) and saying so with `null` is honest, where a tree with a
 * zero-size pane in it would be a lie the renderer has to keep re-checking.
 */
export function closePane(t: Tile, id: string): Tile | null {
  if (t.kind === 'pane') return t.id === id ? null : t;
  const a = closePane(t.a, id);
  const b = closePane(t.b, id);
  if (a === null) return b; // the sibling is promoted into this split's place
  if (b === null) return a;
  return { ...t, a, b };
}

/** Set the ratio of the split at `path`. Out-of-range values are clamped. */
export function setRatio(t: Tile, path: Path, ratio: number): Tile {
  if (t.kind !== 'split') return t; // a path that outruns the tree changes nothing
  if (path.length === 0) return { ...t, ratio: clampRatio(ratio) };
  const [head, ...rest] = path;
  return head === 'a'
    ? { ...t, a: setRatio(t.a, rest, ratio) }
    : { ...t, b: setRatio(t.b, rest, ratio) };
}

/** Keep only panes whose id still exists, and drop the layout when none do.
 *
 * A layout outlives the sessions in it: it is restored from storage into a page
 * whose terminals have since ended, and a pane pointing at a session that is gone
 * frames a tunnel that stopped answering. Reconciling on load — rather than
 * rendering a dead frame and waiting for someone to notice — is the difference
 * between a saved layout and a stale one.
 */
export function retain(t: Tile, live: ReadonlySet<string>): Tile | null {
  if (t.kind === 'pane') return live.has(t.id) ? t : null;
  const a = retain(t.a, live);
  const b = retain(t.b, live);
  if (a === null) return b;
  if (b === null) return a;
  return { ...t, a, b };
}

// ---- derived geometry ------------------------------------------------------
//
// The tree is the MODEL; rectangles are output. Deriving them here — rather than
// nesting the panes in the DOM the way they nest in the tree — is what keeps a
// terminal alive across a split.
//
// Nested flex boxes are the obvious rendering, and they reload every terminal
// the moment you split one: a pane that changes position in the React tree is a
// new element, so its <iframe> is torn down and its shell reconnects from
// scratch. A multiplexer whose panes reset when you rearrange them is not a
// multiplexer. So the panes render as ONE flat list that never reorders, each
// positioned absolutely from the numbers below — the DOM order stays fixed, the
// iframes stay mounted, and only their coordinates change.

/** A pane's box, in percent of the container. */
export interface Rect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A divider's box, plus what to resize when it is dragged. */
export interface Divider {
  path: Path;
  dir: Dir;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the split it resizes starts on its axis, and how long it is, in
   *  percent. A nested split's ratio is a share of ITS extent, not of the
   *  container's, so a drag is read against these. */
  from: number;
  size: number;
}

/** The ratio a divider takes when dragged to `at`, a percent of the container
 *  along the divider's axis. */
export const ratioAt = (d: Pick<Divider, 'from' | 'size'>, at: number): number =>
  d.size > 0 ? (at - d.from) / d.size : 0.5;

export interface Geometry {
  rects: Rect[];
  dividers: Divider[];
}

/** Project a layout onto the unit square, in percent. */
export function geometry(t: Tile): Geometry {
  const rects: Rect[] = [];
  const dividers: Divider[] = [];

  const walk = (n: Tile, path: Path, left: number, top: number, w: number, h: number) => {
    if (n.kind === 'pane') {
      rects.push({ id: n.id, left, top, width: w, height: h });
      return;
    }
    const r = clampRatio(n.ratio);
    if (n.dir === 'row') {
      const aw = w * r;
      walk(n.a, [...path, 'a'], left, top, aw, h);
      walk(n.b, [...path, 'b'], left + aw, top, w - aw, h);
      // The divider straddles the seam; its thickness is the renderer's, so it
      // is given a zero extent on the axis it splits and offset in CSS.
      dividers.push({ path, dir: n.dir, left: left + aw, top, width: 0, height: h, from: left, size: w });
    } else {
      const ah = h * r;
      walk(n.a, [...path, 'a'], left, top, w, ah);
      walk(n.b, [...path, 'b'], left, top + ah, w, h - ah);
      dividers.push({ path, dir: n.dir, left, top: top + ah, width: w, height: 0, from: top, size: h });
    }
  };

  walk(t, [], 0, 0, 100, 100);
  return { rects, dividers };
}

/** A DOM order that only ever grows.
 *
 * The panes render as a flat list whose ORDER decides React's reconciliation, so
 * that order must never depend on anything a server sorts. It did: the list came
 * straight from the sessions array, which the control plane orders by recency —
 * so a session updating its `cwd` could reorder the array, move an iframe among
 * its siblings, and remount every terminal on the page. The invariant this file
 * exists to protect was being broken by the thing it was protecting.
 *
 * Appending new ids and never moving or removing an existing one makes the order
 * a fact about THIS browser session rather than about the server's opinion.
 */
export function stableOrder(prev: readonly string[], present: readonly string[]): string[] {
  const seen = new Set(prev);
  const added = present.filter((id) => !seen.has(id));
  return added.length === 0 ? (prev as string[]) : [...prev, ...added];
}

// ---- the phone projection ---------------------------------------------------
//
// A phone does not tile side by side. 390px cannot hold two terminals and stay
// legible — Blink, Termius and Prompt all refuse to, and none of them is short of
// design effort. What a phone HAS is 844px of height and a swipe.
//
// So the same tree is projected differently rather than modelled twice: a `row`
// split (side by side) becomes two PAGES you swipe between, and a `col` split
// (stacked) stays stacked, because vertical space is the space a phone has. The
// renderer is unchanged — it still consumes `Rect[]`.

export interface PageGeometry extends Geometry {
  /** How many pages the layout occupies. `left` is `page * 100 + offset`. */
  pages: number;
  /** Which page each pane is on, for the tab strip. */
  page: Record<string, number>;
}

/**
 * Project a layout onto N pages of the unit square.
 *
 * `maxStack` bounds how many panes may share one page's height; a `col` group
 * deeper than that spills onto the next page rather than rendering slivers.
 */
export function pageGeometry(t: Tile, maxStack: number): PageGeometry {
  const rects: Rect[] = [];
  const dividers: Divider[] = [];
  const page: Record<string, number> = {};
  const cap = Math.max(1, maxStack);
  let next = 0;

  /** How many panes a subtree wants to stack, if it were all on one page. */
  const stackDepth = (n: Tile): number =>
    n.kind === 'pane' ? 1 : n.dir === 'col' ? stackDepth(n.a) + stackDepth(n.b) : 1;

  const place = (n: Tile, path: Path, pg: number, top: number, h: number) => {
    if (n.kind === 'pane') {
      rects.push({ id: n.id, left: pg * 100, top, width: 100, height: h });
      page[n.id] = pg;
      return;
    }
    if (n.dir === 'row') {
      // Side by side does not fit: each half becomes its own page.
      place(n.a, [...path, 'a'], pg, top, h);
      place(n.b, [...path, 'b'], next++, 0, 100);
      return;
    }
    // Stacked, at its ratio — unless the stack is deeper than the page allows.
    if (stackDepth(n) > cap) {
      place(n.a, [...path, 'a'], pg, top, h);
      place(n.b, [...path, 'b'], next++, 0, 100);
      return;
    }
    const r = clampRatio(n.ratio);
    const ah = h * r;
    place(n.a, [...path, 'a'], pg, top, ah);
    place(n.b, [...path, 'b'], pg, top + ah, h - ah);
    dividers.push({ path, dir: 'col', left: pg * 100, top: top + ah, width: 100, height: 0, from: top, size: h });
  };

  next = 1;
  place(t, [], 0, 0, 100);
  return { rects, dividers, pages: Math.max(next, 1), page };
}

/** How many panes may share one phone page, from the room actually available.
 *
 * Derived, not decreed: the legibility floor is ~20 rows, which at 13px mono plus
 * a header is about 260px. A 844px phone therefore holds two; in landscape it
 * holds one, which is the honest answer rather than three slivers. */
export const stackFor = (availableHeight: number): number =>
  Math.min(3, Math.max(1, Math.floor(availableHeight / 260)));
