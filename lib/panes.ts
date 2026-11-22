/**
 * What a pane SHOWS, kept apart from where it sits.
 *
 * A pane used to be identified by a session id, which braided two questions into
 * one value: *where is this on screen* and *what is running in it*. That braid is
 * why the workspace could not open anything — a split had to find an unused
 * session, so with one session there was nothing to split into and both buttons
 * sat disabled under a sentence explaining why. It is also why a layout collapsed
 * when a run finished: the pane's identity had ended.
 *
 * A pane id is minted here and means only "this box". What it shows is a
 * BINDING — a machine and a shell name — and the URL is derived from the two.
 *
 * ONE LINK SERVES MANY SHELLS. `hanzo link` runs ttyd with `--url-arg`, so the
 * query names a tmux session: `?arg=build` is a shell called build, and no arg is
 * the default. `tmux new -A` attaches or creates, which means opening a shell is
 * a URL and closing a pane loses nothing — reopen the same name and the
 * scrollback is still there. There is no spawn endpoint because none is needed.
 */

import { type Dir, type Tile, closePane, paneIds } from './tiles';

/** A machine that can serve shells: its name and the tunnel its terminals live on. */
export interface TerminalHost {
  machine: string;
  /** The share URL `hanzo link` published. Absent ⇒ nothing to frame. */
  base?: string;
  /** A sandbox's id. Its URLs are MINTED per open (single-use ticket) rather
   *  than published, so a sandbox host has this and no base. */
  sandbox?: string;
  /** Whether this machine has a DISPLAY to watch. It is the machine's own
   *  answer — a `desktop` sandbox runs an X server and a VNC server, the other
   *  classes have neither — and never inferred from a name. */
  screen?: boolean;
  status: string;
  label?: string;
  /** A cloud machine with no kept disk: stopping it deletes its files. */
  temporary?: boolean;
}

/** A shell: which machine, and which tmux session on it. */
export interface Shell {
  machine: string;
  /** `[A-Za-z0-9_-]{1,32}` — the machine sanitises it again, but a UI must never
   *  send a name it did not construct. */
  name: string;
}

export type Binding =
  | { kind: 'shell'; shell: Shell }
  /** The machine's SCREEN — its X display, as pixels. No name, because a
   *  machine has one display where it has as many shells as you ask for. */
  | { kind: 'screen'; machine: string }
  /**
   * A WEB PAGE, at a url.
   *
   * The one binding that is not a machine's face, so there is nothing to link,
   * nothing to start and nothing to mint: the url IS the binding, and it
   * survives a reload the way a shell name does.
   */
  | { kind: 'page'; url: string; }
  /**
   * A machine is being STARTED for this pane, and does not exist yet.
   *
   * The pane is on screen from the click, because the wait is the thing worth
   * watching and it is the longest part: provisioning a cloud machine takes
   * tens of seconds, and a spinner on the button that caused it leaves the
   * workspace looking untouched for all of them. `want` is how the machine will
   * be shown the moment it answers.
   */
  | { kind: 'starting'; want: 'shell' | 'screen' }
  /** No machine came. The pane keeps the reason, and whether the reason was
   *  MONEY — because that one has a remedy the others do not, and a person out
   *  of credit still has a machine of their own to bring. */
  | {
      kind: 'failed';
      why: string;
      unfunded?: boolean;
      /** What was being started, so the pane can offer to start it another way. */
      start?: 'dev' | 'desktop' | 'browser';
    }
  /** The machine went away. The pane STAYS, because tmux is still holding the
   *  session and the layout is the reader's, not a function of someone's uptime. */
  | { kind: 'gone'; shell: Shell };

/** What a pane calls itself: the machine, then which of its faces this is.
 *  One function, so the header, the frame's title and the phone's pager cannot
 *  disagree about what a person is looking at. */
export function label(b: Binding): string {
  switch (b.kind) {
    case 'shell':
      return `${b.shell.machine} · ${b.shell.name}`;
    case 'gone':
      return `${b.shell.machine} · ${b.shell.name}`;
    case 'screen':
      return `${b.machine} · desk`;
    case 'page':
      return host(b.url) || 'New tab';
    case 'starting':
      return b.want === 'screen' ? 'Starting a desktop' : 'Starting a machine';
    case 'failed':
      return 'Could not start';
  }
}

/**
 * What a saved layout becomes on the way back in.
 *
 * A pane comes back only if it can show something: a shell or a screen on a
 * machine that is live now (a `gone` shell is a shell again), or a page. A
 * launch does not survive the page that asked for it — the promise died with
 * the tab — so a saved `starting` or `failed` pane closes, as does a pane on a
 * machine that is no longer there, or one whose binding this version does not
 * know. Closing hands its space to its sibling, so nothing else moves.
 */
export function revive(
  tree: Tile,
  bind: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
): { tree: Tile | null; bind: Record<string, Binding> } {
  let next: Tile | null = tree;
  const kept: Record<string, Binding> = {};
  for (const id of paneIds(tree)) {
    const b = bind[id] as Binding | undefined;
    if ((b?.kind === 'shell' || b?.kind === 'gone') && known.has(b.shell.machine)) {
      kept[id] = { kind: 'shell', shell: b.shell };
    } else if (b?.kind === 'screen' && known.has(b.machine)) kept[id] = b;
    else if (b?.kind === 'page' && b.url) kept[id] = b;
    else if (next) next = closePane(next, id);
  }
  return { tree: next, bind: kept };
}

/** The machine a pane is bound to, whichever way it is looking at it. */
export function machineOf(b: Binding): string | null {
  switch (b.kind) {
    case 'shell':
    case 'gone':
      return b.shell.machine;
    case 'screen':
      return b.machine;
    default:
      return null;
  }
}

/** The tmux session a machine's first pane opens.
 *
 *  It was `hanzo`, which put the company's name where the SHELL's goes and made
 *  a pane read `tabs · hanzo` — two nouns, neither of them obviously the machine
 *  or the session. Numbered from one, a pane says which box and which of its
 *  shells, and nothing has to be recognised.
 *
 *  Only NEW shells take this name: a pane that is already open was saved with
 *  its binding and comes back on the session it was on, so nothing running is
 *  left behind by the rename. */
export const DEFAULT_SHELL = 'shell-1';

const SAFE = /[^A-Za-z0-9_-]/g;

/** Reduce a name to what the machine will accept, so the two never disagree. */
export function safeName(raw: string): string {
  const n = raw.replace(SAFE, '').slice(0, 32);
  return n || DEFAULT_SHELL;
}

/** The next unused shell name for a machine, given what is already open on it. */
export function mintName(taken: readonly string[]): string {
  for (let i = 1; i <= taken.length + 1; i++) {
    const n = `shell-${i}`;
    if (!taken.includes(n)) return n;
  }
  return DEFAULT_SHELL;
}

/**
 * The URL a pane frames.
 *
 * Built with URLSearchParams and exactly one `arg`, never by concatenation:
 * `--url-arg` appends EVERY `arg=` in the query to the command's argv, so a
 * second one is a second argument to a shell running on someone's machine.
 */
export function shellUrl(base: string, name: string): string {
  try {
    const u = new URL(base);
    u.searchParams.set('arg', safeName(name));
    return u.toString();
  } catch {
    return base; // a base we cannot parse is one we must not decorate
  }
}

/**
 * What a typed address becomes, or null if it cannot become a page.
 *
 * Two jobs, and the second is the one that matters. A person types
 * `news.ycombinator.com` and means https, so a bare host gets a scheme. And a
 * typed string reaches an `iframe src`, where `javascript:` and `data:` are
 * script in THIS document rather than a page in the frame — so the scheme is
 * checked against http and https and nothing else is admitted. Refusing is the
 * answer: a browser pane that quietly loaded something else would be worse than
 * one that says it cannot.
 */
export function web(typed: string): string | null {
  const raw = typed.trim();
  if (!raw) return null;
  const guessed = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(guessed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The host of a url, for a tab to name itself by. `www.` comes off because a
 *  tab strip is narrow and the four characters carry nothing. */
export function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}


/** Status → the colour of the dot. The ONE map: session statuses first, then a
 * machine's.
 *
 * `online | offline | draining` is exactly what the control plane sends
 * (agents.TargetOnline/Offline/Draining). `busy` was here once and is sent by
 * nothing; `draining` was missing and fell through to the offline grey, so a box
 * being deliberately drained read as dead.
 *
 * These are the design system's own state colours, read as custom properties.
 * The one exception is a machine on its way somewhere — design publishes no
 * warning rung, so the amber it was already drawing is stated here rather than
 * bent into a token that means something else. */
export const AMBER = '#f59e0b';

export const DOT: Record<string, `var(--${string})` | `#${string}`> = {
  running: 'var(--state-online)',
  paused: AMBER,
  done: 'var(--text-disabled)',
  error: 'var(--destructive)',
  online: 'var(--state-online)',
  draining: AMBER,
  pending: AMBER,
  offline: 'var(--text-disabled)',
};

/**
 * The readiness contract — BOTH halves, in one place.
 *
 * `READY` are the `source` values our framed pages post to their parent once
 * they are up: the terminal's when xterm has opened (hanzo/cli
 * `assets/term/client.js`, cloud `apps/sandbox/term/page.html`), the screen's
 * when noVNC has connected (cloud `apps/sandbox/screen/page.html`). They live
 * here rather than in the component because they are wire values shared with
 * another repository: one side changing one silently is a workspace where every
 * pane of that kind looks dead.
 *
 * Two names and one meaning, on purpose. Each page says WHAT it is, because
 * that costs nothing and a page that lied about itself would be worse; what a
 * parent asks is only whether the thing it framed came up, so the question has
 * one answer for both.
 *
 * The rule this enables is small and the reason for it is not. A parent cannot
 * tell a healthy cross-origin frame from a refused one — the browser substitutes
 * its own error document for a refusal, and BOTH throw on `contentDocument`. So
 * a terminal is present only when it SAYS so, and every way of failing (an OAuth
 * gate, a `frame-ancestors` refusal, a dead tunnel, an offline machine) collapses
 * to the same silence and the same answer.
 */
export const READY = ['hanzo-term', 'hanzo-screen'];

/** How long a pane waits to hear from what it framed before offering the way
 *  out. Long enough that a rescue never flashes over a terminal that is merely
 *  still connecting, which would be its own defect. */
export const DEADLINE = 6000;

/** How long a frame may take to LOAD at all. DEADLINE is counted from the load,
 *  because a frame still fetching its page has not had its chance to speak; this
 *  is the backstop for one whose load never comes. */
export const LOAD_LIMIT = 30_000;

/** How long a machine this workspace has just started is given to bring its
 *  terminal up. A new machine answers the start before its shell is serving, so
 *  the first seconds of silence are it booting, not a failure. */
export const ALLOWANCE = 90_000;


/**
 * The cloud machine that closing pane `id` would leave running in no pane at
 * all, if any: the pane's machine, when no other pane shows it, and it is a
 * cloud machine (`cloud` — the list says so, or this workspace started it,
 * which covers one still pending and so not listed yet).
 */
export function orphaned(
  id: string,
  bind: Readonly<Record<string, Binding>>,
  cloud: (machine: string) => boolean,
): string | null {
  const b = bind[id];
  const m = b ? machineOf(b) : null;
  if (!m || !cloud(m)) return null;
  return Object.entries(bind).some(([k, o]) => k !== id && machineOf(o) === m) ? null : m;
}



/** Whether a posted message is one of our pages announcing itself. */
export function isReady(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    READY.includes((data as { source?: unknown }).source as string)
  );
}

/**
 * Whether a message came from inside a frame: from the frame's own window, or
 * from a window nested in it (a page that wraps its terminal in a frame of its
 * own posts from there). Walked up by `parent`, which a cross-origin window
 * still exposes, and stopped at our own window, so a message from anywhere else
 * — another tab, another frame of ours — is never taken for this one.
 */
export function within(source: unknown, frame: unknown, self: unknown): boolean {
  let w = source as { parent?: unknown } | null | undefined;
  for (let depth = 0; w && depth < 8; depth++) {
    if (w === frame) return true;
    if (w === self || w.parent === w) return false;
    w = w.parent as typeof w;
  }
  return false;
}




/** One open pane as a host's tab strip reads it (the `hanzo:tabs-state` event). */
export interface TabItem {
  id: string;
  title: string;
  /** A `DOT` key: `offline` for a pane with no machine behind it, `pending` while one starts. */
  status: string;
  active: boolean;
}

/** The open panes, in the order they sit, for a host that draws its own tabs.
 *  `statusOf` is what the machine list says about a machine, if it lists it. */
export function tabItems(
  order: readonly string[],
  bind: Readonly<Record<string, Binding>>,
  focus: string | null,
  statusOf: (machine: string) => string | undefined,
): TabItem[] {
  return order
    .filter((id) => bind[id])
    .map((id) => {
      const b = bind[id]!;
      const m = machineOf(b);
      const status =
        b.kind === 'page' ? 'online' : b.kind === 'starting' ? 'pending' : b.kind === 'shell' || b.kind === 'screen' ? (m && statusOf(m)) || 'offline' : 'offline';
      return { id, title: label(b), status, active: id === focus };
    });
}

/**
 * What a framed terminal page may ask of its pane, besides saying it is ready:
 * `{ source: 'hanzo-term', split: 'row' | 'col' }` or `{ source: 'hanzo-term',
 * close: true }`. A page cannot reach its parent's keyboard, so the keys the
 * workspace claims (`lib/keys`) are posted up from inside the frame.
 */
export type TermCommand = { split: Dir } | { close: true };

export function termCommand(data: unknown): TermCommand | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { source?: unknown; split?: unknown; close?: unknown };
  if (d.source !== 'hanzo-term') return null;
  if (d.close === true) return { close: true };
  return d.split === 'row' || d.split === 'col' ? { split: d.split } : null;
}
