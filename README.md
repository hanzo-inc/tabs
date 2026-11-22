# Hanzo Tabs

[![Open in Hanzo](https://hanzo.app/badges/open-in-hanzo.svg)](https://hanzo.app/dev/open?repo=github.com/hanzo-inc/tabs&ref=main&action=open) [![Edit with Hanzo](https://hanzo.app/badges/edit-with-hanzo.svg)](https://hanzo.app/dev/open?repo=github.com/hanzo-inc/tabs&ref=main&action=edit) [![Deploy with Hanzo](https://hanzo.app/badges/deploy-with-hanzo.svg)](https://hanzo.app/dev/open?repo=github.com/hanzo-inc/tabs&ref=main&action=deploy)

**Keep tabs on your agents.**

Your coding agents work in shells on real machines. Tabs puts every one of those
shells in front of you — split, tiled, and reachable from anywhere you can open a
browser.

```bash
hanzo link          # on any machine with a shell
```

Then open [tabs.hanzo.ai](https://tabs.hanzo.ai).

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
components/         the workspace
app/                the marketing page and the workspace page
tests/              39 tests, no browser required
```

The terminal client itself lives in [`hanzoai/cli`](https://github.com/hanzoai/cli)
(`assets/term/`) — xterm.js, themed, with a touch key row — because it is served
by the machine, not by this site.

## Hosting the workspace: starting and stopping cloud computers

A cloud computer costs money on the person's plan, so the workspace never starts
or leaves one running without the person knowing. A host (tabs.hanzo.ai, the
desktop app, hanzo.ai) passes these props:

```ts
<Workspace
  hosts={fleet.hosts}
  mint={fleet.mint}
  streams={fleet.streams}            // number | null: the plan's tab limit
  account={fleet.account}            // string | null: whose "Don't ask again"
  onLaunch={fleet.launch}            // (kind: Kind, opts: { temporary: boolean }) => Promise<string>
  onStop={fleet.stop}                // (host: TerminalHost) => Promise<void>
  confirmLease={hostConfirm}         // optional: (ask: StartAsk) => boolean | Promise<boolean>
/>
```

- **Every new machine goes through one start path**, whatever asked for it
  (toolbar, split, picker, the host's `hanzo:tabs-action` menu, the temporary
  machine offered when credit runs out). One start is in flight at a time; a
  second press while one is asking or starting does nothing.
- **`confirmLease`, when passed, is the ONLY asker.** The workspace then never
  asks a question of its own before a start, and shows no "Don't ask again".
  It is called once per start with everything the person must be told:

  ```ts
  type StartAsk = {
    kind: 'dev' | 'desktop' | 'browser';
    temporary: boolean;   // keeps no files: they are lost when it stops
    beyond: boolean;      // the plan's streamed-tab limit is reached: it would run unseen
    limit: number | null; // that limit: 0 none, N a cap, -1 no cap, null not told
    from: 'button' | 'split' | 'menu' | 'picker';
    expires: number;      // ms since the epoch (Date.now()): the answer's deadline
  };
  ```

  Only an answer of exactly `true` before `expires` (two minutes after the ask)
  starts the machine. `false`, any other value, a throw, a rejection or a later
  answer starts nothing — so at `expires` the host should close its question
  and say that nothing was started.
- **Without `confirmLease`** the workspace asks with the stack's AlertDialog, and
  offers "Don't ask again" per account and per class of machine — never for a
  temporary machine, never when the plan is unknown (`streams` null), has no
  streams (0) or is full. "Ask before starting again" in the toolbar undoes it.
- **`onLaunch(kind, { temporary })`** starts the machine and answers the name it
  goes by in `hosts`. `temporary: true` is sent only after the person chose a
  machine that keeps no files, in those words.
- **`onStop(host)`** stops one. Closing the last pane on a cloud machine (or one
  this workspace started that is still pending) asks "Keep it running" or "Stop
  it"; for a temporary machine the question says its files will be lost, and
  keeping it is the answer focused first. Without `onStop` the person is told it
  is still running.

## Hosting the workspace: a window of its own

A host with no browser around the workspace (the desktop app's webview) can ask
for four more things. All are off or absent by default, so a browser tab is
unchanged.

```ts
<Workspace
  shortcuts          // claim ⌘D / ⌘⇧D (split right / down), ⌘W (close), ⌘= ⌘- ⌘0 (type size)
  inlineFrames       // fetch each terminal page here and frame it as a blob: document
  minPane={420}      // px: the row scrolls sideways rather than squeeze a pane narrower
/>
```

- **`shortcuts`** is for hosts that own the window: in a browser those keys are
  the browser's. Command only; Control stays the terminal's (Ctrl+D, Ctrl+W).
  ⌘W with no pane to close is left to the host. With `inlineFrames` the keys also
  work while a terminal has focus.
- **`inlineFrames`** is for a webview whose own origin is not in the terminal
  page's `frame-ancestors` (`tauri://localhost`): the page is fetched, its socket
  pointed at the minted address, and framed as a blob (`lib/inline.ts`).
- **A terminal page** may post `{ source: 'hanzo-term', split: 'row' | 'col' }` or
  `{ source: 'hanzo-term', close: true }` to split or close its own pane, and the
  host may ask for `split` and `close` on `hanzo:tabs-action`: both only with
  `shortcuts` on, and ignored otherwise.
- **An inlined frame runs in an opaque origin** (`sandbox="allow-scripts"`, no
  `allow-same-origin`): a blob inherits the origin that made it, and the page was
  fetched from the network, so it must not get the host's storage or sign-in
  token. Only the cloud's own terminal address (`API`, path
  `/v1/sandbox(es)/:id/terminal`) is ever fetched.
- **The host's tab strip** hears `hanzo:tabs-state` with `{ bind, items, focus }`
  (`items`: `{ id, title, status, active }` per open pane, in order); the same is
  kept at `window.__hanzoTabsState` for a host that mounts later. It asks back on
  `hanzo:tabs-action` with `focus`, `close` (an `id`, or the focused pane; pass
  `res: { handled: false }` to learn whether a pane was closed), `split` (`dir`),
  `shell`, `desktop`, `page` and `cloud`.

## Develop

```bash
pnpm install
pnpm dev             # http://localhost:3000
pnpm test            # the layout engine and bindings
pnpm typecheck
```

MIT.
