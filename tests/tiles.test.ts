import {
  MAX_RATIO,
  MIN_RATIO,
  append,
  balance,
  closePane,
  hasPane,
  geometry,
  neighbour,
  pageGeometry,
  pane,
  paneIds,
  ratioAt,
  retain,
  setRatio,
  splitPane,
  stableOrder,
  stackFor,
  type Tile,
} from '@/lib/tiles';

/**
 * The layout is a tree so that closing a pane has an exact answer.
 *
 * Every test here is about a rewrite, not a rectangle: no browser, no layout
 * engine, no pixels. If these hold, the renderer's only remaining job is to turn
 * the tree into flex boxes — and a bug there shows up as a wrong-looking split,
 * never as a pane that has silently lost its terminal.
 */
describe('a layout is a tree, and closing a pane proves it', () => {
  it('a split puts the new pane in the SECOND half, where it is drawn', () => {
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(paneIds(t)).toEqual(['a', 'b']);
    expect(t).toMatchObject({ kind: 'split', dir: 'row', ratio: 0.5 });
  });

  it("a closed pane's space goes to its sibling — not to arithmetic", () => {
    // a | (b / c) — closing b must leave a | c, with c holding the whole half.
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    expect(paneIds(t)).toEqual(['a', 'b', 'c']);

    const after = closePane(t, 'b')!;
    expect(paneIds(after)).toEqual(['a', 'c']);
    // The inner split is GONE: c was promoted into its place, so the outer split
    // still divides exactly two things.
    expect(after).toMatchObject({
      kind: 'split',
      dir: 'row',
      a: { kind: 'pane', id: 'a' },
      b: { kind: 'pane', id: 'c' },
    });
  });

  it('closing the last pane is an empty layout, said out loud', () => {
    expect(closePane(pane('only'), 'only')).toBeNull();
  });

  it('closing a pane that is not there changes nothing', () => {
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(closePane(t, 'ghost')).toEqual(t);
  });

  it('splitting a target no pane shows changes nothing', () => {
    // A split has to name where it happens; inventing a location would put a
    // terminal somewhere nobody asked for.
    const t = pane('a');
    expect(splitPane(t, 'ghost', 'row', 'new')).toEqual(t);
  });
});

describe('sweep order falls out of the tree', () => {
  const built = (): Tile => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    return splitPane(t, 'c', 'row', 'd');
  };

  it('reads left-to-right, top-to-bottom', () => {
    expect(paneIds(built())).toEqual(['a', 'b', 'c', 'd']);
  });

  it('steps forward and back, and wraps at both ends', () => {
    const t = built();
    expect(neighbour(t, 'a', 1)).toBe('b');
    expect(neighbour(t, 'd', 1)).toBe('a'); // wraps forward
    expect(neighbour(t, 'a', -1)).toBe('d'); // wraps back
    expect(neighbour(t, 'c', -1)).toBe('b');
  });

  it('a pane that is not in the layout lands somewhere real', () => {
    // The focused pane can vanish (its session ended) while a key is in flight;
    // answering with the first pane beats answering with nothing.
    expect(neighbour(built(), 'ghost', 1)).toBe('a');
  });
});

describe('a divider stops before it erases a pane', () => {
  it('clamps to a floor and a ceiling', () => {
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(setRatio(t, [], 0)).toMatchObject({ ratio: MIN_RATIO });
    expect(setRatio(t, [], 1)).toMatchObject({ ratio: MAX_RATIO });
    expect(setRatio(t, [], 0.42)).toMatchObject({ ratio: 0.42 });
  });

  it('a NaN drag does not destroy the layout', () => {
    // A pointer event during a re-layout can measure a zero-height container.
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(setRatio(t, [], NaN)).toMatchObject({ ratio: 0.5 });
  });

  it('resizes the split the path names, and leaves its siblings alone', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    const after = setRatio(t, ['b'], 0.25) as Extract<Tile, { kind: 'split' }>;
    expect(after.ratio).toBe(0.5); // the outer split is untouched
    expect(after.b).toMatchObject({ kind: 'split', ratio: 0.25 });
  });

  it('a path that outruns the tree changes nothing', () => {
    const t = pane('a');
    expect(setRatio(t, ['a', 'b'], 0.3)).toEqual(t);
  });
});

describe('a saved layout is reconciled against what is actually live', () => {
  it('drops panes whose session has ended and keeps the rest', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    const after = retain(t, new Set(['a', 'c']))!;
    expect(paneIds(after)).toEqual(['a', 'c']);
    expect(hasPane(after, 'b')).toBe(false);
  });

  it('a layout of only-dead panes is no layout at all', () => {
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(retain(t, new Set<string>())).toBeNull();
  });

  it('keeps the tree untouched when everything is still live', () => {
    const t = splitPane(pane('a'), 'a', 'row', 'b');
    expect(retain(t, new Set(['a', 'b']))).toEqual(t);
  });
});

describe('geometry is derived, so the panes can stay put in the DOM', () => {
  it('one pane fills the container', () => {
    const { rects, dividers } = geometry(pane('a'));
    expect(rects).toEqual([{ id: 'a', left: 0, top: 0, width: 100, height: 100 }]);
    expect(dividers).toEqual([]);
  });

  it('a row splits the width and leaves the height alone', () => {
    const { rects, dividers } = geometry(setRatio(splitPane(pane('a'), 'a', 'row', 'b'), [], 0.25));
    expect(rects).toEqual([
      { id: 'a', left: 0, top: 0, width: 25, height: 100 },
      { id: 'b', left: 25, top: 0, width: 75, height: 100 },
    ]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ dir: 'row', left: 25, path: [] });
  });

  it('a col splits the height', () => {
    const { rects } = geometry(setRatio(splitPane(pane('a'), 'a', 'col', 'b'), [], 0.4));
    expect(rects).toEqual([
      { id: 'a', left: 0, top: 0, width: 100, height: 40 },
      { id: 'b', left: 0, top: 40, width: 100, height: 60 },
    ]);
  });

  it('every pane gets a box, and the boxes tile the container exactly', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    t = splitPane(t, 'c', 'row', 'd');
    const { rects, dividers } = geometry(t);
    expect(rects.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    // No gaps and no overlap: the areas sum to the whole.
    const area = rects.reduce((s, r) => s + r.width * r.height, 0);
    expect(Math.round(area)).toBe(100 * 100);
    // One divider per split.
    expect(dividers).toHaveLength(3);
  });

  it('a divider names the split it resizes', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    const { dividers } = geometry(t);
    const inner = dividers.find((d) => d.dir === 'col')!;
    // Dragging it must resize the INNER split, not the root.
    const after = setRatio(t, inner.path, 0.2) as Extract<Tile, { kind: 'split' }>;
    expect(after.ratio).toBe(0.5);
    expect(after.b).toMatchObject({ ratio: 0.2 });
  });
});

describe('New makes room evenly; a split divides only its pane', () => {
  const widths = (t: Tile) =>
    Object.fromEntries(geometry(t).rects.map((r) => [r.id, Math.round(r.width * 1000) / 1000]));

  it('New on an empty workspace is the whole of it', () => {
    expect(append(null, 'a')).toEqual(pane('a'));
  });

  it('1 → 2 → 3 → 4 columns from New are equal every time — never half of the last', () => {
    let t = append(null, 'a');
    t = append(t, 'b');
    expect(widths(t)).toEqual({ a: 50, b: 50 });
    t = append(t, 'c');
    expect(widths(t)).toEqual({ a: 33.333, b: 33.333, c: 33.333 });
    t = append(t, 'd');
    expect(widths(t)).toEqual({ a: 25, b: 25, c: 25, d: 25 });
    expect(paneIds(t)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a split right divides that pane alone, whichever pane it is', () => {
    let t = append(append(append(null, 'a'), 'b'), 'c');
    t = splitPane(t, 'b', 'row', 'n');
    expect(widths(t)).toEqual({ a: 33.333, b: 16.667, n: 16.667, c: 33.333 });
    expect(paneIds(t)).toEqual(['a', 'b', 'n', 'c']);
  });

  it('a split down divides that pane alone, and its column keeps its width', () => {
    let t = append(append(append(null, 'a'), 'b'), 'c');
    t = splitPane(t, 'c', 'col', 'n');
    const r = Object.fromEntries(geometry(t).rects.map((x) => [x.id, x]));
    expect(r.c).toMatchObject({ top: 0, height: 50 });
    expect(r.n).toMatchObject({ top: 50, height: 50 });
    expect(Math.round(r.n!.left * 1000) / 1000).toBe(66.667);
    expect(widths(t)).toEqual({ a: 33.333, b: 33.333, c: 33.333, n: 33.333 });
    expect(r.a).toMatchObject({ top: 0, height: 100 });
  });

  it('New after a split evens the columns, and a stacked column counts as one', () => {
    let t = append(append(null, 'a'), 'b');
    t = splitPane(t, 'b', 'col', 'n');
    t = append(t, 'c');
    expect(widths(t)).toEqual({ a: 33.333, b: 33.333, n: 33.333, c: 33.333 });
    const r = Object.fromEntries(geometry(t).rects.map((x) => [x.id, x]));
    expect(r.b).toMatchObject({ height: 50 });
  });

  it('a layout stacked at the root becomes one column of two', () => {
    const t = append(splitPane(pane('a'), 'a', 'col', 'b'), 'c');
    expect(widths(t)).toEqual({ a: 50, b: 50, c: 50 });
    expect(t).toMatchObject({ kind: 'split', dir: 'row', ratio: 0.5 });
  });

  it('balance changes ratios only: the same panes, in the same order', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'row', 'c');
    t = setRatio(t, [], 0.8);
    const even = balance(t);
    expect(paneIds(even)).toEqual(paneIds(t));
    expect(widths(even)).toEqual({ a: 33.333, b: 33.333, c: 33.333 });
    expect(balance(pane('a'))).toEqual(pane('a'));
  });

  it("a nested divider drags against its own split's extent, so it stays under the pointer", () => {
    const t = append(append(append(null, 'a'), 'b'), 'c');
    // The second seam sits at 66.7%; dragging it to 75% must put it at 75%,
    // moving the two columns beside it and not the first.
    const seam = geometry(t).dividers.find((d) => Math.round(d.left) === 67)!;
    const moved = setRatio(t, seam.path, ratioAt(seam, 75));
    expect(widths(moved)).toEqual({ a: 33.333, b: 41.667, c: 25 });
    expect(geometry(moved).dividers.map((d) => Math.round(d.left * 1000) / 1000).sort()).toEqual([33.333, 75]);
  });

  it('a stacked divider on a phone page drags against its page height', () => {
    const t = splitPane(splitPane(pane('a'), 'a', 'col', 'b'), 'b', 'col', 'c');
    const g = pageGeometry(t, 3);
    const inner = g.dividers.find((d) => d.path.length === 1)!;
    expect(inner).toMatchObject({ from: 50, size: 50 });
    const after = setRatio(t, inner.path, ratioAt(inner, 60)) as Extract<Tile, { kind: 'split' }>;
    expect(after.b).toMatchObject({ ratio: 0.2 });
  });
});

describe('the DOM order is this browser’s, not the server’s', () => {
  it('keeps what it had and appends what is new', () => {
    expect(stableOrder(['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('IGNORES a reorder — which is the whole point', () => {
    // The control plane sorts sessions by recency, so this array really does
    // reorder in normal use. Following it would move an iframe among its
    // siblings and remount every terminal on the page.
    const prev = ['a', 'b', 'c'];
    expect(stableOrder(prev, ['c', 'b', 'a'])).toBe(prev);
    expect(stableOrder(prev, ['b', 'a', 'c'])).toBe(prev);
  });

  it('keeps a departed id in place rather than closing the gap', () => {
    // Removing it would shift every later sibling and remount their frames. The
    // renderer skips an id with no rect; the ORDER does not need to know.
    expect(stableOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns the SAME array when nothing is new, so React sees no change', () => {
    const prev = ['a', 'b'];
    expect(stableOrder(prev, ['a', 'b'])).toBe(prev);
    expect(stableOrder(prev, [])).toBe(prev);
  });
});

describe('a phone pages instead of tiling side by side', () => {
  it('one pane is one page', () => {
    const g = pageGeometry(pane('a'), 2);
    expect(g.pages).toBe(1);
    expect(g.rects).toEqual([{ id: 'a', left: 0, top: 0, width: 100, height: 100 }]);
  });

  it('a ROW split becomes two pages — 390px cannot hold two terminals', () => {
    const g = pageGeometry(splitPane(pane('a'), 'a', 'row', 'b'), 2);
    expect(g.pages).toBe(2);
    expect(g.page).toEqual({ a: 0, b: 1 });
    expect(g.rects.find((r) => r.id === 'b')!.left).toBe(100); // the second page
    expect(g.rects.every((r) => r.width === 100)).toBe(true);  // each fills its page
  });

  it('a COL split STAYS stacked — height is what a phone has', () => {
    const g = pageGeometry(setRatio(splitPane(pane('a'), 'a', 'col', 'b'), [], 0.4), 2);
    expect(g.pages).toBe(1);
    expect(g.rects).toEqual([
      { id: 'a', left: 0, top: 0, width: 100, height: 40 },
      { id: 'b', left: 0, top: 40, width: 100, height: 60 },
    ]);
    expect(g.dividers).toHaveLength(1); // and it can still be dragged
  });

  it('a stack deeper than the page allows spills to the next page', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'col', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    expect(pageGeometry(t, 3).pages).toBe(1);  // room for three
    expect(pageGeometry(t, 2).pages).toBe(2);  // room for two: the third spills
    expect(pageGeometry(t, 1).pages).toBe(3);  // room for one: all separate
  });

  it('every pane lands on exactly one page, and fills its page width', () => {
    let t: Tile = splitPane(pane('a'), 'a', 'row', 'b');
    t = splitPane(t, 'b', 'col', 'c');
    t = splitPane(t, 'c', 'row', 'd');
    const g = pageGeometry(t, 2);
    expect(Object.keys(g.page).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(g.rects).toHaveLength(4);
    for (const r of g.rects) {
      expect(r.width).toBe(100);
      expect(r.left % 100).toBe(0); // page-aligned
      expect(g.page[r.id]).toBe(r.left / 100);
    }
  });

  it('the stack count comes from the room, not from a number someone picked', () => {
    expect(stackFor(670)).toBe(2);  // 390x844 portrait
    expect(stackFor(254)).toBe(1);  // landscape: one, not three slivers
    expect(stackFor(900)).toBe(3);  // a tablet
    expect(stackFor(0)).toBe(1);    // never zero
  });
});
