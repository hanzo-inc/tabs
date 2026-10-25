# Hanzo Tabs

**Keep tabs on your agents.**

Your coding agents work in shells on real machines. Tabs puts every one of those
shells in front of you — split, tiled, and reachable from anywhere you can open a
browser.

```bash
hanzo link          # on any machine with a shell
```

Then open [tabs.hanzo.ai](https://tabs.hanzo.ai), or Tabs in the app at
[hanzo.ai/tabs](https://hanzo.ai/tabs) and [platform.hanzo.ai/tabs](https://platform.hanzo.ai/tabs).
All three draw the one component this package publishes, `Tabs`.

## Why it is shaped this way

**There is no backend.** Not "a small one" — none. `hanzo link` publishes a
terminal from the machine over a zero-trust tunnel, already authenticated and
already gated, and the browser frames it directly. A server here would be a third
party to a conversation that has two, plus one more thing to keep running and one
more place a credential could sit.

**A shell is a URL.** ttyd runs with `--url-arg` behind a wrapper that names a
tmux session, so `?arg=build` *is* a shell called `build` and `tmux new -A`
attaches or creates. One link serves as many independent shells as you ask for.
There is no spawn endpoint because none is needed — and closing a pane loses
nothing, since reopening the name reopens the session with its scrollback.

**The layout is a tree, and that is the whole design.** A list of rectangles is
the shape that looks easier and then cannot answer the only question that
matters: close a pane, and who gets the space? With a tree it is structural — the
space belongs to the sibling, so closing replaces the parent split *with* that
sibling and nothing else moves. `lib/tiles.ts` is that tree and nothing else:
split, close, resize, sweep order, page projection — every one a pure rewrite,
tested without a browser.

**Rectangles are derived, and that keeps a shell alive.** Nesting panes in the
DOM the way they nest in the tree remounts every `<iframe>` on any split, and
each terminal reconnects. So `geometry()` projects the tree onto percentages, the
panes render as one flat list that never reorders, and only their coordinates
change.

**A phone pages; it does not tile.** 390px cannot hold two terminals and stay
legible. Side-by-side splits become swipeable pages, stacked splits stay stacked,
and how many share a page is derived from the room — landscape gets one rather
than three slivers.

## Layout

```
lib/tiles.ts        the layout tree + geometry + the phone projection (pure)
lib/panes.ts        what a pane shows: a machine and a shell name (pure)
lib/api.ts          the control-plane read, from the browser
components/tabs    Tabs, whole: the fleet read with a host's token, then the workspace
components/         the workspace
app/                the marketing page and the workspace page
tests/              39 tests, no browser required
```

The terminal client itself lives in [`hanzoai/cli`](https://github.com/hanzoai/cli)
(`assets/term/`) — xterm.js, themed, with a touch key row — because it is served
by the machine, not by this site.

## Develop

```bash
pnpm install
pnpm dev             # http://localhost:3000
pnpm test            # the layout engine and bindings
pnpm typecheck
```

MIT.
