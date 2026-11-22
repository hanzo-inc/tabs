'use client';

/**
 * The terminal workspace — split, resize, sweep, and open new shells.
 *
 * Arrangement lives in `lib/tiles` (a tree, pure) and what a pane SHOWS lives in
 * `lib/panes` (a binding, pure). This file turns those into boxes, and turns
 * pointers back into rewrites. It decides nothing about layout.
 *
 * FIVE THINGS ARE NOT OBVIOUS, AND ALL FIVE WERE LEARNED THE HARD WAY.
 *
 * 1. THE PANES ARE A FLAT LIST IN A FIXED ORDER. Nesting them the way the tree
 *    nests remounts every <iframe> on any split, and each terminal reconnects.
 *    The order comes from `stableOrder` — append-only — because it once came from
 *    the sessions array, which the control plane sorts by RECENCY: a session
 *    touching its cwd could reorder the array and remount the whole page.
 *
 * 2. A DRAG NEEDS A SHEET. The pointer leaves the divider and immediately crosses
 *    an iframe, which swallows the event; the drag dies a few pixels in. A
 *    transparent overlay for the duration keeps the events on this document.
 *
 * 3. A TERMINAL PROVES ITSELF; IT IS NOT INFERRED. The rescue must be ON TOP of
 *    the frame — measured at eight viewports, `elementFromPoint` returned the
 *    iframe every time, so a way out underneath is no way out. And WHETHER to
 *    show it comes from the terminal saying `hanzo-term: ready`, never from
 *    reading the frame's DOM: a gate redirect ending at hanzo.id's
 *    `frame-ancestors 'none'` leaves `chrome-error://chromewebdata/`, which
 *    throws on contentDocument exactly like a healthy cross-origin load. Silence
 *    is the rescue; every way a frame can fail is the same silence.
 *
 * 4. A PHONE PAGES, IT DOES NOT TILE. 390px cannot hold two terminals and stay
 *    legible, so `pageGeometry` turns side-by-side splits into swipeable pages
 *    and keeps stacked ones stacked. Same tree, same renderer.
 *
 * 5. THE NARROW LAYOUT IS ONE MEASUREMENT, NOT A MEDIA QUERY. `paging` already
 *    asks the only question worth asking — can this box hold two terminals —
 *    and the chrome that used to answer it separately, at a viewport width,
 *    now reads the same value. gui emits nothing at all for a breakpoint prop
 *    without its optimizing compiler — measured, `$gtXs={{backgroundColor:
 *    'red'}}` painted no red at 1440 and put no class on the element — so a
 *    second breakpoint written that way would have been silently absent
 *    rather than merely redundant.
 */

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Cloud,
  Columns2,
  Globe,
  Loader2,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Rows2,
  SquareTerminal,
  X,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Input,
  Label,
  Paragraph,
  SizableText,
  XStack,
  YStack,
} from '@hanzo/ui';

import { AgentPanel } from './agent';
import { FRAME, frameFilter, useScheme } from '../lib/scheme';
import type { AgentFrame, AgentTurn } from '../lib/api';

import {
  type TerminalHost,
} from '../lib/panes';
import {
  type Dir,
  type Divider,
  type Geometry,
  type Tile,
  along,
  append,
  canvasWidth,
  closePane,
  geometry,
  pageGeometry,
  pane,
  paneIds,
  ratioAt,
  scrollFor,
  setRatio,
  splitPane,
  stableOrder,
  stackFor,
} from '../lib/tiles';
// One import, and it is a PURE READING of an error — no origin, no token, no
// request. The workspace still holds no credential; what it gains is the
// platform's own word for "no money", which is the one failure whose remedy
// differs from every other.
import { signIn, unfunded } from '../lib/api';
import {
  DOT,
  type Binding,
  isReady,
  label,
  machineOf,
  mintName,
  orphaned,
  web,
  revive,
  tabItems,
  termCommand,
  within,
} from '../lib/panes';
import { shortcut } from '../lib/keys';
import { UPGRADE, full, over } from '../lib/plan';
import {
  type Come,
  type ComeEvent,
  type Listed,
  WAITING_EVENT,
  address,
  begin,
  due,
  step as advance,
  view,
  waiting,
} from '../lib/comeup';
import {
  type Kind,
  type StartAsk,
  HOST_PATIENCE,
  answerBy,
  decide,
  forget,
  quietKinds,
  remember,
  silent,
  startQuestion,
  stopQuestion,
} from '../lib/start';

/** This browser's storage, or none where it cannot be reached. */
const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The stack's own props, taken from the stack. @hanzo/ui is the one import
 *  source, so a local alias beats reaching past it to @hanzo/gui for a type. */
type StackProps = React.ComponentProps<typeof YStack>;
/** What a caller may add to a Chip — a Button's props, not a Stack's. The two
 *  differ on `onClick` alone: @hanzo/ui redeclares it as the DOM handler a web
 *  caller actually writes, so spreading Stack props onto a Button conflicts
 *  there and nowhere else. Layout props reach it either way. */
type ButtonProps = React.ComponentProps<typeof Button>;

const STORE_KEY = 'hanzo.tabs.layout.v1';

interface Saved {
  tree: Tile | null;
  bind: Record<string, Binding>;
  seq: number;
}

function load(): Saved | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as Saved) : null;
    return v && v.bind ? v : null;
  } catch {
    return null; // a corrupt layout is no layout, never a crash
  }
}

/**
 * How big the type is, in every terminal at once.
 *
 * It is kept APART from the layout, under its own key, because they are answers
 * to different questions: a layout is this workspace's arrangement and a person
 * rearranges it all day, while type size is how their eyes work and should
 * survive closing every pane they have.
 *
 * The terminal is a cross-origin frame, so this cannot be CSS — it is a message
 * the pane's own page applies to its live terminal, on the reverse leg of the
 * channel the readiness handshake already uses. Sending it on every change AND
 * on every pane that reports ready is what makes one setting reach panes that
 * open later, with nothing to remember.
 */
const SIZE_KEY = 'hanzo.tabs.size.v1';

/** The host's menu asks the workspace for a pane by this event, and hears the
 *  open panes by the other (@hanzo/app Sidebar): its detail is `{ bind, items,
 *  focus }` (`TabItem`), also kept at `window.__hanzoTabsState` for a host that
 *  mounts after the workspace's last announcement. */
const ACTION_EVENT = 'hanzo:tabs-action';
const STATE_EVENT = 'hanzo:tabs-state';

/** One thing the host's menu asks for. `split` divides the focused pane in `dir`;
 *  `close` closes pane `id`, or the focused one. A host that closes its window
 *  when there is no pane to close passes `res` and reads `handled` after. */
type Action = {
  kind: 'shell' | 'desktop' | 'page' | 'cloud' | 'focus' | 'split' | 'close';
  machine?: string;
  id?: string;
  dir?: Dir;
  res?: { handled: boolean };
};

/** One question the workspace puts to the person. */
type Ask = {
  title: string;
  say: string;
  yes: string;
  /** The safe answer, focused first. Absent, the question is a notice whose
   *  one button is `yes`. */
  no?: string;
  /** Offer "Don't ask again", in these words: what it would cover. */
  remember?: string;
};

/** Where a new pane goes: splitting `target` in `dir`, or — null — a new column
 *  at the top level, the level evened to make room (`append`). */
type At = { dir: Dir; target: string } | null;

/** The terminal's face, @hanzo/font's mono first. One constant, because the
 *  workspace tells a terminal its type in two places and they must not differ. */
const MONO = "'Zen Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

const SIZE = { min: 8, max: 32, step: 1, default: 12 } as const;

function clampSize(n: number): number {
  return Math.min(SIZE.max, Math.max(SIZE.min, Math.round(n)));
}

function loadSize(): number {
  if (typeof window === 'undefined') return SIZE.default;
  const n = Number(window.localStorage.getItem(SIZE_KEY));
  return Number.isFinite(n) && n > 0 ? clampSize(n) : SIZE.default;
}

/** A pane's name bar is 28px, so every control in it is 24px and no larger —
 *  each pixel here is a row of terminal, times the number of panes. */
const BAR = 28;
const CHIP = 24;

/** The cover a pane wears when there is no terminal to look at. Six states used
 *  to draw this by hand, and the reason it has to be a component rather than a
 *  convention is #3 above: it sits ON TOP of the frame, and a way out underneath
 *  is no way out. */
function Cover({ children, ...rest }: StackProps) {
  return (
    <YStack
      position="absolute"
      inset={0}
      z={10}
      items="center"
      justify="center"
      px="$4"
      {...rest}
    >
      {children}
    </YStack>
  );
}

/** What a cover says. Narrow, small, quiet, centred — the pane is the subject. */
function Note({ children }: { children: ReactNode }) {
  return (
    <Paragraph maxW={320} size="$1" text="center" color="var(--muted-foreground)">
      {children}
    </Paragraph>
  );
}

/** A machine's state, as a dot. */
function Dot({ status }: { status: string }) {
  return (
    <YStack
      aria-hidden
      width={6}
      height={6}
      shrink={0}
      rounded={9999}
      bg={DOT[status] ?? DOT.offline}
    />
  );
}

/** One control in a pane's name bar. */
function Chip({
  run,
  title,
  children,
  ...rest
}: { run: () => void; title: string; children: ReactNode } & ButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      minW={CHIP}
      minH={CHIP}
      rounded={4}
      title={title}
      aria-label={title}
      onPress={run}
      {...rest}
    >
      {children}
    </Button>
  );
}

/**
 * A browser pane's chrome: where it is, and the way back.
 *
 * The address takes the place of the title rather than sitting in a second row.
 * For a page the address IS the title, and a row of chrome costs every pane on
 * screen the same pixels a row of terminal would have used.
 *
 * `web` decides what a typed string becomes, so a scheme we do not frame is
 * refused here rather than reaching an iframe src.
 */
function Address({
  url,
  go,
  disabled,
}: {
  url: string;
  go: (to: string) => void;
  disabled?: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  // The field shows what is typed while someone is typing and what is LOADED
  // otherwise, so a navigation started elsewhere is reflected and a half-typed
  // address is never overwritten under the cursor.
  const shown = typed ?? url;

  const submit = () => {
    const to = web(shown);
    if (!to) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setTyped(null);
    go(to);
  };

  return (
    <Input
      value={shown}
      placeholder="Search or enter a URL"
      aria-label="Address"
      aria-invalid={refused || undefined}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      disabled={disabled}
      onChangeText={(t: string) => {
        setTyped(t);
        setRefused(false);
      }}
      onKeyPress={(e: { nativeEvent: { key: string } }) => {
        if (e.nativeEvent.key === 'Enter') submit();
      }}
      onBlur={() => setTyped(null)}
      flex={1}
      minW={0}
      height={CHIP}
      rounded={4}
      fontSize={12}
      px="$2"
      borderColor={refused ? 'var(--destructive)' : 'var(--border)'}
      bg="var(--background)"
    />
  );
}

export function Workspace({
  hosts,
  mint,
  onLaunch,
  onStop,
  confirmLease,
  account,
  agent,
  streams = null,
  shortcuts = false,
  minPane,
  start,
  end,
}: {
  hosts: TerminalHost[];
  /** What sits at the ends of the action row — the brand, and the way out.
   *  They are the page's, not the workspace's, but they are three controls
   *  wide and a row of their own cost every pane 28px of terminal. A workspace
   *  is measured in rows you can read, so the row they belong in is this one. */
  start?: ReactNode;
  end?: ReactNode;
  /** A fresh URL for a pane, for whatever that pane shows. EVERY pane, not only
   *  a sandbox's: a machine you linked and a machine we started differ in who
   *  serves the page and what credential opens it, and in nothing a layout cares
   *  about. The caller owns the token; the workspace only ever holds the URL. */
  mint?: (host: TerminalHost, what: Binding) => Promise<string>;
  /** Start a cloud machine of one class, and answer the name it goes by here.
   *  `temporary` asks for one that keeps no files, and is only ever sent after
   *  the person chose that in those words (out of credit, see the failed pane). */
  onLaunch?: (kind: Kind, opts: { temporary: boolean }) => Promise<string>;
  /** Stop a cloud machine. Absent, a pane that could not connect to one cannot
   *  offer to stop it. */
  onStop?: (host: TerminalHost) => Promise<void>;
  /** Asked before the workspace starts a NEW cloud computer — never for another
   *  pane on one already running. Answer true to start it. Absent, the
   *  workspace asks itself ("This starts another cloud computer on your
   *  plan"). A host with its own confirm on its menu answers true for
   *  `from: 'menu'`, so one action is never asked twice. */
  confirmLease?: (ask: StartAsk) => boolean | Promise<boolean>;
  /** Who is signed in (`useFleet().account`). "Don't ask again" is kept per
   *  account and per class of machine; absent, it is not offered. */
  account?: string | null;
  /** Have the AI work a cloud machine (cloud's sandbox agent). Absent, no pane offers it. */
  agent?: (
    host: TerminalHost,
    body: { message: string; history: AgentTurn[] },
    onFrame: (f: AgentFrame) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** How many tabs the plan lets stream at once (`lib/plan.ts`): 0 none, N a cap,
   *  -1 no cap, null not told — which caps no stream, and makes every start of
   *  a cloud computer ask first ("Don't ask again" needs a plan to lean on). */
  streams?: number | null;
  /** Claim ⌘D / ⌘⇧D (split right / down), ⌘W (close the focused pane) and
   *  ⌘= ⌘- ⌘0 (type size) for the workspace, from this document. It also admits the split
   *  and close that arrive as `hanzo:tabs-action` events and as a terminal
   *  page's message; with it off those are ignored. Off by default: in a
   *  browser tab these keys are the browser's. A host with no browser around it (a desktop webview) turns
   *  it on. */
  shortcuts?: boolean;
  /** The narrowest a pane may be, in px, before the row scrolls sideways
   *  instead of squeezing every pane narrower. Absent, panes share the width
   *  however many there are. */
  minPane?: number;
}) {
  // A machine with no `base` serves no terminal, and there is nothing to open on
  // one of those — except a sandbox, whose URL is minted on bind rather than
  // published.
  const live = useMemo(
    () => hosts.filter((h) => (h.base || h.sandbox) && h.status !== 'offline'),
    [hosts],
  );
  /** The live machines with a display. A linked machine has none to offer —
   *  what `hanzo link` publishes is a terminal — so this is the sandboxes that
   *  were started as desktops. */
  const watchable = useMemo(() => live.filter((h) => h.screen), [live]);

  const [tile, setTile] = useState<Tile | null>(null);
  /** The panes whose AI is shown. A pane's conversation outlives hiding it. */
  const [talking, setTalking] = useState<Record<string, boolean>>({});
  const [bind, setBind] = useState<Record<string, Binding>>({});
  const seq = useRef(0);
  const initialSaved = useRef<Saved | null | undefined>(undefined);
  const [ready, setReady] = useState(false);

  // Bring the saved layout back through `revive`, which keeps only the panes
  // that can show something now, so a reload never lays out dead columns. If no
  // saved pane survives, open the first live machine's default shell.
  useEffect(() => {
    if (initialSaved.current === undefined) {
      initialSaved.current = load();
    }
    const saved = initialSaved.current;
    const known = new Set(live.map((h) => h.machine));

    if (!ready) {
      if (saved?.tree) {
        seq.current = saved.seq ?? 0;
        const { tree: nextTree, bind: nextBind } = revive(saved.tree, saved.bind, known);
        if (nextTree) {
          setBind(nextBind);
          setTile(nextTree);
          initialSaved.current = null;
        } else if (live[0]) {
          const id = `p${seq.current++}`;
          setBind({ [id]: { kind: 'shell', shell: { machine: live[0].machine, name: mintName([]) } } });
          setTile(pane(id));
          initialSaved.current = null;
        }
      } else if (live[0]) {
        const id = `p${seq.current++}`;
        setBind({ [id]: { kind: 'shell', shell: { machine: live[0].machine, name: mintName([]) } } });
        setTile(pane(id));
        initialSaved.current = null;
      }
      setReady(true);
      return;
    }

    // If hosts arrived asynchronously after initial mount while the workspace is still empty,
    // restore any matching panes from initialSaved or open the first live machine.
    if (!tile && live.length > 0 && initialSaved.current !== undefined) {
      if (saved?.tree) {
        const { tree: nextTree, bind: nextBind } = revive(saved.tree, saved.bind, known);
        initialSaved.current = null;
        if (nextTree) {
          setBind(nextBind);
          setTile(nextTree);
          return;
        }
      }
      initialSaved.current = null;
      if (live[0]) {
        const id = `p${seq.current++}`;
        setBind({ [id]: { kind: 'shell', shell: { machine: live[0].machine, name: mintName([]) } } });
        setTile(pane(id));
        return;
      }
    }

    // Revive any pane marked `gone` whose machine is now back in `live`.
    setBind((prev) => {
      let changed = false;
      const next: Record<string, Binding> = {};
      for (const [id, b] of Object.entries(prev)) {
        if (b.kind === 'gone' && known.has(b.shell.machine)) {
          next[id] = { kind: 'shell', shell: b.shell };
          changed = true;
        } else {
          next[id] = b;
        }
      }
      return changed ? next : prev;
    });
  }, [live, ready, tile]);

  useEffect(() => {
    if (!ready) return;
    try {
      if (tile) {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ tree: tile, bind, seq: seq.current }));
      } else {
        window.localStorage.removeItem(STORE_KEY);
      }
    } catch {
      /* private mode or quota — a layout that cannot be saved still works today */
    }
  }, [tile, bind, ready]);

  const ids = useMemo(() => (tile ? paneIds(tile) : []), [tile]);
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => setOrder((p) => stableOrder(p, ids)), [ids]);

  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !ids.includes(focus)) setFocus(ids[0] ?? null);
  }, [ids, focus]);

  const hostOf = useCallback((m: string) => hosts.find((h) => h.machine === m), [hosts]);

  // The host's menu and tab strip list the open panes from this. `storage`
  // fires only in OTHER tabs, so the page that changed the layout says so itself.
  useEffect(() => {
    if (!ready) return;
    const detail = { bind, items: tabItems(order, bind, focus, (m) => hostOf(m)?.status), focus };
    (window as unknown as { __hanzoTabsState?: unknown }).__hanzoTabsState = detail;
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail }));
  }, [bind, order, focus, hostOf, ready]);

  /** Shell names already open on a machine, so a new one does not collide. */
  const takenOn = useCallback(
    (m: string) =>
      Object.values(bind)
        .filter(
          (b): b is Extract<Binding, { kind: 'shell' }> =>
            b.kind === 'shell' && b.shell.machine === m,
        )
        .map((b) => b.shell.name),
    [bind],
  );

  /** What a machine looks like in a pane, each way of looking at one. Two
   *  functions and not a flag, because only one of them has a name to mint. */
  const shellOn = useCallback(
    (machine: string): Binding => ({
      kind: 'shell',
      shell: { machine, name: mintName(takenOn(machine)) },
    }),
    [takenOn],
  );
  const screenOn = useCallback((machine: string): Binding => ({ kind: 'screen', machine }), []);

  /** Open a NEW pane showing `what`: splitting `at.target`, which divides that
   *  pane's space and no other, or — with no `at` — as a new column, every
   *  column made equal. Answers with the pane's id, so a caller still waiting
   *  on what goes in it can settle that one box later. */
  const open = useCallback((what: Binding, at: At) => {
    const id = `p${seq.current++}`;
    setBind((b) => ({ ...b, [id]: what }));
    setTile((t) => (t && at ? splitPane(t, at.target, at.dir, id) : append(t, id)));
    setFocus(id);
    return id;
  }, []);

  /** Put `what` in a pane that is still open. A pane closed while its machine
   *  was starting stays closed — an answer arriving late must not reopen a box
   *  someone shut. */
  const settle = useCallback((id: string, what: Binding) => {
    setBind((b) => (b[id] ? { ...b, [id]: what } : b));
  }, []);

  /** The machines this workspace started. A pane on one is starting even
   *  before the list has it (lib/comeup `begin`). */
  const startedHere = useRef(new Set<string>());

  // ---- questions: one at a time, over the panes ----------------------------
  const [asks, setAsks] = useState<
    (Ask & { n: number; answer: (yes: boolean, remember: boolean) => void })[]
  >([]);
  const asked = useRef(0);
  // Focus goes back once, when the LAST queued question is answered: handing
  // it back between two would pull it behind the second dialog. It goes to
  // the control that opened the first one, or — when that is gone, as a
  // closed pane's Close button is — to the focused pane, else the workspace's
  // first control, never to the page's body.
  const queued = useRef(0);
  const opener = useRef<Element | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const focusNow = useRef<string | null>(null);
  focusNow.current = focus;
  const handBack = () => {
    // A question asked while this waited (a stop that failed at once) owns
    // focus now; it is handed back when that one is answered.
    if (queued.current > 0) return;
    const was = opener.current;
    opener.current = null;
    // The opener may be the host's own menu, outside the workspace: any control
    // still on the page gets focus back. The page's body is no control — it is
    // what is focused when nobody pressed anything, or when a click does not
    // focus a button (Safari) — so it falls back like a closed pane's button.
    const to =
      was instanceof HTMLElement && was.isConnected && was !== document.body
        ? was
        : (frames.current[focusNow.current ?? ''] ??
          rootRef.current?.querySelector<HTMLElement>('button:not([aria-disabled="true"])'));
    to?.focus();
  };
  const ask = useCallback(
    (q: Ask) =>
      new Promise<{ yes: boolean; remember: boolean }>((done) => {
        const n = asked.current++;
        if (queued.current++ === 0) opener.current = document.activeElement;
        let settled = false;
        setAsks((a) => [
          ...a,
          {
            ...q,
            n,
            answer: (yes, remember) => {
              if (settled) return;
              settled = true;
              setAsks((x) => x.filter((y) => y.n !== n));
              if (--queued.current === 0) setTimeout(handBack, 0);
              done({ yes, remember });
            },
          },
        ]);
      }),
    // handBack reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The machines as they are NOW, for an answer given renders after the ask.
  const hostsNow = useRef(hosts);
  hostsNow.current = hosts;
  /** Panes closed while their machine was still starting. */
  const abandoned = useRef(new Set<string>());
  /** Temporary machines this workspace started, known before the list has them. */
  const keepsNothing = useRef(new Set<string>());

  /** A cloud computer no pane shows any more is still running on the plan, so
   *  the person is asked whether to keep it, never left to find it later. */
  const offerStop = useCallback(
    (machine: string) => {
      const temporary = !!hostsNow.current.find((x) => x.machine === machine)?.temporary || keepsNothing.current.has(machine);
      void ask(stopQuestion(machine, { temporary, canStop: !!onStop })).then(async (a) => {
        if (!a.yes || !onStop) return;
        try {
          const h = hostsNow.current.find((x) => x.machine === machine);
          if (!h) throw new Error('it is not in the list of machines yet');
          await onStop(h);
        } catch (e) {
          void ask({
            title: `Could not stop ${machine}`,
            say: `Could not stop ${machine} (${e instanceof Error ? e.message : 'no answer'}). It is still running.`,
            yes: 'OK',
          });
        }
      });
    },
    [ask, onStop],
  );

  /** Start a machine for pane `id` and open it there. The point of the button
   *  is what you get to look at: a machine that arrives with nothing framed on
   *  it is a row in a list, and you would have to go and ask for the thing you
   *  already asked for. */
  const boot = useCallback(
    (id: string, kind: Kind, temporary = false): Promise<unknown> => {
      if (!onLaunch) return Promise.resolve();
      const want = kind === 'dev' ? 'shell' : 'screen';
      settle(id, { kind: 'starting', want });
      return onLaunch(kind, { temporary })
        .then((machine) => {
          startedHere.current.add(machine);
          if (temporary) keepsNothing.current.add(machine);
          // Its pane was closed while it started: it is running, on the plan,
          // in no pane at all — which is exactly when the person must be told.
          if (abandoned.current.delete(id)) offerStop(machine);
          else settle(id, want === 'screen' ? screenOn(machine) : shellOn(machine));
        })
        .catch((e) =>
          !abandoned.current.delete(id) &&
          settle(id, {
            kind: 'failed',
            why: e instanceof Error ? e.message : 'could not start a machine',
            unfunded: unfunded(e),
            start: kind,
          }),
        );
    },
    [onLaunch, settle, shellOn, screenOn, offerStop],
  );

  // The layout as it is NOW, for a start answered after its question was open:
  // the pane it was asked from may have closed meanwhile.
  const tileNow = useRef(tile);
  tileNow.current = tile;
  const bindNow = useRef(bind);
  bindNow.current = bind;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The classes this account said not to be asked about, as shown in the
   *  toolbar's way to undo it. Re-read when the account changes. */
  const [quiet, setQuiet] = useState<Kind[]>([]);
  useEffect(() => setQuiet(quietKinds(store(), account)), [account]);

  /** The workspace's own question before a start. */
  const askToStart = async (a: StartAsk) => {
    const said = await ask(startQuestion(a, account));
    if (said.yes && said.remember) {
      remember(store(), account, a.kind);
      setQuiet(quietKinds(store(), account));
    }
    return said.yes;
  };

  /**
   * THE start path: every new cloud computer, whatever asked for it, comes
   * through here, and here alone calls `boot`. One start is in flight at a time,
   * from the press until the machine answers; the controls that start one are
   * disabled meanwhile, and a press that arrives anyway is ignored.
   *
   * The pane opens once the start is agreed, in `at` (or in the open pane
   * `into`, which the start fills), and the machine starts in it.
   */
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const startMachine = async (req: { kind: Kind; from: StartAsk['from']; at?: At; into?: string; temporary?: boolean }) => {
    if (!onLaunch) return;
    const a: StartAsk = {
      kind: req.kind,
      from: req.from,
      temporary: !!req.temporary,
      // From what streams now: a pane started into is a failed one, streaming nothing.
      beyond: full(rendered, bind, streams),
      limit: streams,
      expires: Date.now() + HOST_PATIENCE,
    };
    const plan = decide({
      busy: starting.current,
      host: !!confirmLease,
      quiet: silent(quietKinds(store(), account).includes(a.kind), a, account),
    });
    if (plan === 'ignore') return;
    starting.current = true;
    setBusy(true);
    try {
      const yes =
        plan === 'go' ||
        (plan === 'host' ? await answerBy(() => confirmLease!(a), a.expires) : await askToStart(a));
      if (!yes || !mounted.current) return;
      let id = req.into;
      if (id) {
        if (!bindNow.current[id]) return; // the pane it was for has closed
      } else {
        const at = req.at && tileNow.current && paneIds(tileNow.current).includes(req.at.target) ? req.at : null;
        id = open({ kind: 'starting', want: req.kind === 'dev' ? 'shell' : 'screen' }, at);
      }
      await boot(id, req.kind, a.temporary);
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** What the host's menu asked for, answered by this render's buttons. A ref,
   *  so the window listener is added once and still acts on current state. */
  const act = useRef<(a: Action) => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => {
      const a = (e as CustomEvent<Action>).detail;
      if (a && typeof a.kind === 'string') act.current(a);
    };
    window.addEventListener(ACTION_EVENT, on);
    return () => window.removeEventListener(ACTION_EVENT, on);
  }, []);

  const doClose = useCallback((id: string) => {
    setTile((t) => (t ? closePane(t, id) : null));
    setBind((b) => {
      const next = { ...b };
      delete next[id];
      return next;
    });
  }, []);

  // ---- geometry: desktop tiles, phone pages ------------------------------
  const boxRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]!.contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The box is not there while the workspace shows its empty state, and a
    // box that appears later (the first machine, the first pane) is a new element.
  }, [ready, live.length === 0 && !tile]);

  // The breakpoint is the ROOM, not the device: a phone in landscape and a narrow
  // desktop window have the same problem, and neither can hold two terminals.
  const paging = box.w > 0 && box.w < 640;
  const paged = useMemo(
    () => (tile && paging ? pageGeometry(tile, stackFor(box.h)) : null),
    [tile, paging, box.h],
  );
  const geo: Geometry = useMemo(
    () => paged ?? (tile ? geometry(tile) : { rects: [], dividers: [] }),
    [paged, tile],
  );
  const placed = useMemo(() => new Map(geo.rects.map((r) => [r.id, r])), [geo]);

  // With `minPane`, panes keep a readable width: when the narrowest would be
  // squeezed below it, the canvas they sit on grows past the box and the box scrolls.
  const canvas = paging ? box.w : canvasWidth(geo.rects, box.w, minPane);
  const scrolls = canvas > box.w;
  const scroller = useRef<HTMLElement | null>(null);

  const pages = paged?.pages ?? 1;
  const [page, setPage] = useState(0);
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);
  useEffect(() => {
    // Following the focused pane keeps the strip and the view in agreement.
    if (paged && focus && paged.page[focus] !== undefined) setPage(paged.page[focus]!);
  }, [paged, focus]);

  // ---- dragging a divider -------------------------------------------------
  const [drag, setDrag] = useState<Divider | null>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return;
      // In the paged projection the track is `pages * 100%` wide and shifted, so a
      // horizontal drag is measured against ONE page, not the whole track. On a
      // scrolled canvas it is measured against the canvas, from where it starts.
      const at =
        drag.dir === 'row'
          ? along(e.clientX, r.left, scrolls ? (scroller.current?.scrollLeft ?? 0) : 0, scrolls ? canvas : r.width)
          : (100 * (e.clientY - r.top)) / r.height;
      // The ratio is a share of the split's OWN extent: read against the whole
      // box, a nested divider jumped away from the pointer on the first move.
      setTile((t) => (t ? setRatio(t, drag.path, ratioAt(drag, at)) : t));
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, scrolls, canvas]);

  // The focused pane is brought into view on a scrolled canvas when focus moves
  // (or the canvas starts to scroll), never while a divider is dragged: every
  // step of a drag re-lays the panes, and following the focus then fights the pointer.
  const lay = useRef({ placed, canvas, drag });
  lay.current = { placed, canvas, drag };
  useEffect(() => {
    const el = scroller.current;
    const { placed: now, canvas: width, drag: dragging } = lay.current;
    const r = focus ? now.get(focus) : undefined;
    if (!scrolls || !el || !r || dragging) return;
    const to = scrollFor(r, width, el.scrollLeft, el.clientWidth);
    if (to !== null) el.scrollTo({ left: to, behavior: 'smooth' });
  }, [focus, scrolls]);

  // Click-to-focus from INSIDE a frame: the click never reaches this document,
  // but the window losing focus does, and activeElement is then the iframe.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const el = document.activeElement;
        if (el instanceof HTMLIFrameElement && el.dataset.pane) setFocus(el.dataset.pane);
      }, 0);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // A pane shows the rescue unless ITS OWN TERMINAL SAYS IT IS THERE.
  //
  // Inferring this from the DOM does not work, and shipped broken twice. The
  // guess was that a refusal stays at `about:blank` — same-origin, readable,
  // empty — while a real load throws on contentDocument. There is a third case
  // and it is the COMMON one: the frame follows the tunnel to its OAuth gate,
  // the gate redirects to hanzo.id, hanzo.id sends `frame-ancestors 'none'`, and
  // Chrome swaps in `chrome-error://chromewebdata/`. That throws exactly like a
  // successful load, so every genuinely-blocked terminal read as fine and the
  // user got an opaque black rectangle with no way out.
  //
  // So stop inferring. Our terminal page posts `hanzo-term: ready` when xterm has
  // booted (cli/assets/term/client.js), and that message is the only thing
  // treated as proof. Silence past the deadline is the rescue, whatever the
  // cause — gate, CSP, dead tunnel, offline machine. One signal, one meaning, and
  // no case analysis to get wrong the next time a browser invents a fourth way to
  // fail.
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});

  // ---- how each pane comes up: ONE machine (lib/comeup), ONE runner -------
  // The machine decides; this runs what it asks for (an address, a wake-up)
  // and feeds it what happens (the list, the mint's answer, the frame's load
  // and ready). A pane that closes, is capped, or loses its machine loses its
  // state and its timer with it.
  const [come, setCome] = useState<Record<string, Come>>({});
  const epochs = useRef(0);
  const send = useCallback(
    (id: string, e: ComeEvent) => setCome((c) => (c[id] ? { ...c, [id]: advance(c[id]!, e) } : c)),
    [],
  );

  const [size, setSize] = useState(loadSize);
  const scheme = useScheme();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // A terminal page asking for a split or a close (`termCommand`): said
      // for ITS pane, so that pane is the target, and a framed web page has no
      // such say.
      const cmd = termCommand(e.data);
      if (cmd) {
        if (!shortcuts) return;
        for (const [id, el] of Object.entries(frames.current)) {
          if (el && within(e.source, el.contentWindow, window)) {
            if (bindNow.current[id]?.kind === 'page') return;
            setFocus(id);
            act.current('close' in cmd ? { kind: 'close', id } : { kind: 'split', dir: cmd.split, id });
            return;
          }
        }
        return;
      }
      if (!isReady(e.data)) return;
      // The sender identifies the pane: a message is trusted only when it comes
      // from inside a frame this workspace actually rendered — its window or
      // one nested in it, since a page may wrap its terminal in a frame. The
      // origin is not pinned because every machine publishes on its own host.
      for (const [id, el] of Object.entries(frames.current)) {
        if (el && within(e.source, el.contentWindow, window)) {
          send(id, { type: 'ready' });
          el.contentWindow?.postMessage({
            source: 'hanzo-term',
            fontSize: size,
            fontFamily: MONO,
          }, '*');
          return;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [size, send, shortcuts]);

  // The reader's type size, told to every terminal that is up.
  //
  // It runs on the come-up as well as on the size itself, so a pane that boots after
  // the setting was chosen is told as soon as it says it is ready — the same
  // signal, used for the same reason, rather than a second notion of when a
  // frame can be spoken to. A pane that never answers is never sent to, which is
  // right: there is nothing there to hear it.
  useEffect(() => {
    window.localStorage.setItem(SIZE_KEY, String(size));
    for (const [id, el] of Object.entries(frames.current)) {
      if (come[id]?.at === 'ready') {
        el?.contentWindow?.postMessage({
          source: 'hanzo-term',
          fontSize: size,
          fontFamily: MONO,
        }, '*');
      }
    }
  }, [size, come]);

  /**
   * Where a browser pane has been, and where in that it is.
   *
   * Kept HERE because it cannot be read from the frame: a cross-origin
   * document's `history` is not ours to touch, so `back()` on it throws. What
   * this holds is the addresses this workspace navigated to — typed, or
   * followed from one of our own affordances — and back and forward re-point
   * the frame at one of them.
   *
   * The limit is worth stating rather than hiding: a link followed INSIDE the
   * page is the page's own navigation and never reaches this trail, so back
   * returns to the last address this workspace set, not to the last page the
   * reader saw. A parent cannot observe the other kind at all.
   */
  const [trail, setTrail] = useState<Record<string, { at: number; urls: string[] }>>({});

  /** Go to an address in a pane, forgetting any forward history from here —
   *  which is what a new navigation means. */
  const visit = useCallback((id: string, to: string) => {
    setBind((s) => ({ ...s, [id]: { kind: 'page', url: to } }));
    setTrail((t) => {
      const cur = t[id] ?? { at: -1, urls: [] };
      const urls = [...cur.urls.slice(0, cur.at + 1), to];
      return { ...t, [id]: { at: urls.length - 1, urls } };
    });
  }, []);

  /** Step through a pane's trail. A step past either end is not a step. */
  const step = useCallback((id: string, by: number) => {
    setTrail((t) => {
      const cur = t[id];
      if (!cur) return t;
      const at = cur.at + by;
      if (at < 0 || at >= cur.urls.length) return t;
      setBind((s) => ({ ...s, [id]: { kind: 'page', url: cur.urls[at]! } }));
      return { ...t, [id]: { ...cur, at } };
    });
  }, []);

  /**
   * Reload a pane's page.
   *
   * By assigning the frame's `src`, which a parent may do cross-origin — it is
   * a navigation the parent initiates, not a read of the document. Re-keying
   * the element would work too and would remount every sibling's frame, which
   * is the one thing this layout is arranged to avoid.
   */
  const reload = useCallback((id: string) => {
    const el = frames.current[id];
    if (el) el.src = el.src;
  }, []);

  // A pick is "which machine", and what to MAKE of the one picked comes with
  // the question — so the same picker asks for a shell's machine and a
  // screen's, and neither knows about the other.
  const [picking, setPicking] = useState<null | {
    make: (m: string) => Binding;
    from: TerminalHost[];
    at: At;
    /** What "New machine" starts, when the picker offers one. */
    kind: Kind;
  }>(null);
  const rendered = useMemo(() => order.filter((id) => bind[id]), [order, bind]);
  /** The panes past what the plan streams. They are kept and shown, never minted. */
  const capped = useMemo(() => over(rendered, bind, streams), [rendered, bind, streams]);

  /** What the list says about a machine, as the come-up machine reads it. */
  const listedOf = useCallback(
    (m: string): Listed => {
      const h = live.find((x) => x.machine === m);
      return !h ? 'gone' : h.status === 'pending' ? 'pending' : 'running';
    },
    [live],
  );

  // Which panes come up, and what the list says to each. A pane begins when it
  // shows a machine and is not capped; it is dropped when it closes, is capped
  // or stops showing one. Everything starts over when the account changes.
  const forAccount = useRef(account);
  useEffect(() => {
    const fresh = forAccount.current !== account;
    forAccount.current = account;
    setCome((c) => {
      const was = fresh ? {} : c;
      const next: Record<string, Come> = {};
      for (const id of rendered) {
        const b = bind[id];
        const m = b && (b.kind === 'shell' || b.kind === 'screen') ? machineOf(b) : null;
        if (!m || capped.has(id)) continue;
        const now = Date.now();
        next[id] = was[id]
          ? advance(was[id]!, { type: 'list', listed: listedOf(m), now, epoch: ++epochs.current })
          : begin(now, listedOf(m), startedHere.current.has(m), ++epochs.current);
      }
      const same = Object.keys(next).length === Object.keys(c).length && Object.keys(next).every((id) => next[id] === c[id]);
      return same ? c : next;
    });
  }, [rendered, bind, capped, listedOf, account]);

  // What the machine asks for: an address, once per attempt. With no `mint`
  // from the host, or no machine to mint on, the ask fails at once and the
  // machine decides what that means, as it does for any other failure.
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    // Forget asks for panes that closed and attempts that moved on.
    for (const k of askedFor.current) {
      const [id, epoch] = k.split(':');
      if (String(come[id!]?.epoch) !== epoch) askedFor.current.delete(k);
    }
    for (const [id, c] of Object.entries(come)) {
      const key = due(c).mint;
      if (!key || c.at !== 'minting' || askedFor.current.has(`${id}:${key}`)) continue;
      askedFor.current.add(`${id}:${key}`);
      const { epoch, tries } = c;
      const failed = (e: unknown) =>
        send(id, { type: 'mint-failed', signIn: signIn(e), epoch, tries, now: Date.now() });
      const b = bindNow.current[id];
      const m = b ? machineOf(b) : null;
      const h = m ? hostOf(m) : undefined;
      if (!mint || !b || !h) failed(null);
      else mint(h, b).then((url) => send(id, { type: 'minted', url, epoch, tries }), failed);
    }
  }, [come, mint, hostOf, send]);

  // Tell the fleet whether a pane waits on the list, so it reads it quickly
  // only then (lib/fleet `every`).
  const anyWaiting = waiting(come);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(WAITING_EVENT, { detail: { waiting: anyWaiting } }));
  }, [anyWaiting]);
  useEffect(
    () => () => void window.dispatchEvent(new CustomEvent(WAITING_EVENT, { detail: { waiting: false } })),
    [],
  );

  // And when to look again: one timer per pane, at the time the machine names,
  // replaced when that changes and cleared when the pane's state goes.
  const wakes = useRef<Record<string, { at: number; t: ReturnType<typeof setTimeout> }>>({});
  useEffect(() => {
    for (const [id, w] of Object.entries(wakes.current)) {
      if (!come[id] || due(come[id]!).wake !== w.at) {
        clearTimeout(w.t);
        delete wakes.current[id];
      }
    }
    for (const [id, c] of Object.entries(come)) {
      const at = due(c).wake;
      if (at === undefined || wakes.current[id]) continue;
      const t = setTimeout(() => {
        delete wakes.current[id];
        // A timer may fire a moment before the time it was set for.
        send(id, { type: 'tick', now: Math.max(Date.now(), at) });
      }, Math.max(0, at - Date.now()));
      wakes.current[id] = { at, t };
    }
  }, [come, send]);
  useEffect(
    () => () => {
      for (const w of Object.values(wakes.current)) clearTimeout(w.t);
    },
    [],
  );

  /** Reconnect a pane: the come-up begins again, with a fresh address. */
  const reconnect = (id: string) => {
    const b = bindNow.current[id];
    const m = b ? machineOf(b) : null;
    if (m) send(id, { type: 'reconnect', listed: listedOf(m), now: Date.now(), epoch: ++epochs.current });
  };

  /** Close a pane. Closing the last pane on a cloud computer asks whether to
   *  stop it, and closing one still starting asks when it arrives. */
  const close = (id: string) => {
    if (bind[id]?.kind === 'starting') abandoned.current.add(id);
    const m = orphaned(id, bind, (x) => !!hostOf(x)?.sandbox || startedHere.current.has(x));
    doClose(id);
    if (m) offerStop(m);
  };

  /** Never make someone choose from a set of one — and with no machine to
   *  pick, a new one is the set of one. */
  const openHere = (
    make: (m: string) => Binding,
    from: TerminalHost[],
    at: At,
    kind: Kind,
    via: StartAsk['from'] = 'button',
  ) => {
    if (from.length === 1) open(make(from[0]!.machine), at);
    else if (from.length === 0 && onLaunch) void startMachine({ kind, at, from: via });
    else setPicking({ make, from, at, kind });
  };

  /** A shell goes on any live machine. */
  const openShell = (at: At, via: StartAsk['from'] = 'button') => openHere(shellOn, live, at, 'dev', via);

  /** A split divides the pane it was asked of, and with a launcher what goes in
   *  the new half is a NEW machine, unasked: a split is for another place to
   *  work, and asking where it should run made every split a question. */
  const split = (dir: Dir, target: string) =>
    onLaunch ? void startMachine({ kind: 'dev', at: { dir, target }, from: 'split' }) : openShell({ dir, target });

  /** A page needs no machine, so it needs no picker and no mint — the pane
   *  opens empty and the address is the whole of what it wants. */
  const openPage = (at: At) => open({ kind: 'page', url: '' }, at);

  /** A screen goes only where there IS one. With a launcher, "New desktop" is a
   *  new desktop every press: one that reused the first live one made a second
   *  press look like nothing happened. Without one, the screens that exist are
   *  all there is. */
  const openScreen = (at: At, via: StartAsk['from'] = 'button') =>
    onLaunch ? void startMachine({ kind: 'desktop', at, from: via }) : openHere(screenOn, watchable, at, 'desktop', via);

  /** A browser, the way its button makes one: a machine with a launcher, a
   *  framed page without. */
  const openBrowser = (at: At, via: StartAsk['from'] = 'button') =>
    onLaunch ? void startMachine({ kind: 'browser', at, from: via }) : openPage(at);

  /** The host's menu (@hanzo/app Sidebar) draws beside the workspace and holds
   *  none of its state, so it asks by event: each kind is the button of the same
   *  name, a machine names which one, and `focus` names a pane. A shell with no
   *  machine to go on starts one, which is what a person asking for a terminal
   *  on an empty workspace wants. Each is New, as the buttons are: a column, the
   *  columns evened. */
  useEffect(() => {
    act.current = (a) => {
      const on = a.machine ? live.find((h) => h.machine === a.machine) : undefined;
      switch (a.kind) {
        case 'shell':
          if (on) open(shellOn(on.machine), null);
          else if (live.length) openShell(null, 'menu');
          else if (onLaunch) void startMachine({ kind: 'dev', from: 'menu' });
          return;
        case 'desktop':
          if (on?.screen) open(screenOn(on.machine), null);
          else openScreen(null, 'menu');
          return;
        case 'page':
          openBrowser(null, 'menu');
          return;
        case 'cloud':
          if (onLaunch) void startMachine({ kind: 'dev', from: 'menu' });
          return;
        case 'focus':
          if (a.id && bind[a.id]) setFocus(a.id);
          return;
        case 'split': {
          if (!shortcuts) return;
          const target = a.id && bind[a.id] ? a.id : (focus ?? rendered[0] ?? null);
          if (target) split(a.dir === 'col' ? 'col' : 'row', target);
          else act.current({ kind: 'shell' });
          return;
        }
        case 'close': {
          if (!shortcuts) return;
          const target = a.id && bind[a.id] ? a.id : (focus ?? rendered[0] ?? null);
          if (!target) return;
          close(target);
          if (a.res) a.res.handled = true;
          return;
        }
      }
    };
  });

  // The keys `shortcut` names, when the host owns the window. Captured, so a
  // focused field or an iframe's parent sees them first; claimed only when
  // there is something to do, so ⌘W with no pane is left to the host (its
  // window).
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const k = shortcut(e);
      if (!k) return;
      if (k === 'split-row' || k === 'split-col') act.current({ kind: 'split', dir: k === 'split-row' ? 'row' : 'col' });
      else if (k === 'close') {
        const res = { handled: false };
        act.current({ kind: 'close', res });
        if (!res.handled) return;
      } else setSize((n) => (k === 'reset' ? SIZE.default : clampSize(n + (k === 'bigger' ? SIZE.step : -SIZE.step))));
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shortcuts]);

  // The visible undo for "Don't ask again", beside the start buttons wherever
  // they are: there while anything is remembered for this account, gone once
  // it is undone.
  const reset =
    quiet.length > 0 && !confirmLease ? (
      <Button
        variant="ghost"
        size="sm"
        onPress={() => {
          forget(store(), account);
          setQuiet([]);
        }}
      >
        <SizableText size="$1">Ask before starting again</SizableText>
      </Button>
    ) : null;

  // The question being asked, over everything it is about.
  const question = asks[0] ? (
    <Question key={asks[0].n} q={asks[0]} onAnswer={asks[0].answer} />
  ) : null;

  if (live.length === 0 && !tile) {
    return (
      <YStack
        ref={(el) => {
          rootRef.current = el instanceof HTMLElement ? el : null;
        }}
        position="relative"
        height="100%"
        width="100%"
        items="center"
        justify="center"
        gap="$3"
        px="$5"
        rounded="$4"
        borderWidth={1}
        borderStyle="dashed"
        borderColor="$borderColor"
      >
        <Paragraph maxW={384} size="$2" text="center" color="var(--muted-foreground)">
          No machine is serving terminals. Run{' '}
          <SizableText render="code" size="$2" fontFamily="$mono" color="$color">
            hanzo link
          </SizableText>{' '}
          on one and it appears here.
        </Paragraph>
        {/* The header is not rendered in this branch, and someone with no machine
            at all is exactly who has nowhere else to get one. */}
        {onLaunch ? (
          <XStack items="center" gap="$1.5">
            <Act disabled={busy} run={() => void startMachine({ kind: 'dev', from: 'button' })} icon={<Cloud size={14} />} label="New cloud computer" />
            <Act disabled={busy} run={() => void startMachine({ kind: 'desktop', from: 'button' })} icon={<Monitor size={14} />} label="New desktop" />
            <Act disabled={busy} run={() => void startMachine({ kind: 'browser', from: 'button' })} icon={<Globe size={14} />} label="New browser" />
          </XStack>
        ) : null}
        {reset}
        {question}
      </YStack>
    );
  }

  return (
    <YStack
      ref={(el) => {
        rootRef.current = el instanceof HTMLElement ? el : null;
      }}
      data-slot="tabs-root"
      height="100%"
      width="100%"
      gap="$2.5"
      p="$3"
    >
      {/* One row. Actions, not a status report. */}
      <XStack data-slot="tabs-strip" shrink={0} items="center" gap="$2">
        {start}
        <XStack data-slot="tabs-actions" items="center" gap="$2">
        <Act
          disabled={busy}
          run={() => openShell(null)}
          icon={<SquareTerminal size={14} />}
          label="New shell"
        />
        {/* One button starts a desktop. A second, only while one is live, opens a
            pane on it again: a desktop is a machine you keep, and a pane is one
            way to look at it. */}
        {watchable.length || onLaunch ? (
          <Act
            disabled={busy}
          run={() => openScreen(null)}
            icon={<Monitor size={14} />}
            label={onLaunch ? 'New desktop' : 'Desktop'}
          />
        ) : null}
        {onLaunch && watchable.length ? (
          <Act
            run={() => openHere(screenOn, watchable, null, 'desktop')}
            icon={<Monitor size={14} />}
            label="Open desktop"
          />
        ) : null}
        {/* With a launcher, a browser is a machine: Chromium on a screen you watch and
            an agent can drive. A framed page is what a host with none can offer. */}
        <Act
          disabled={busy}
          run={() => openBrowser(null)}
          icon={<Globe size={14} />}
          label={onLaunch ? 'New browser' : 'Browse'}
        />
        {onLaunch ? (
          <Act
            disabled={busy}
            run={() => void startMachine({ kind: 'dev', from: 'button' })}
            icon={<Cloud size={14} />}
            label="New cloud computer"
          />
        ) : null}
        </XStack>
        <XStack ml="auto" shrink={0} items="center" gap="$1.5">
          {reset}
          {/* Type size. Two buttons and the number they move — a stepper IS the
              setting, so there is no panel to open and nothing to find. It reads
              its own state, which a slider or a menu would each need a second
              affordance to do. */}
          <XStack
            data-slot="tabs-size"
            mr="$1"
            items="center"
            rounded="$2"
            borderWidth={1}
            borderColor="$borderColor"
          >
            <Button
              variant="ghost"
              size="sm"
              px="$2"
              onPress={() => setSize((n) => clampSize(n - SIZE.step))}
              disabled={size <= SIZE.min}
              title="Smaller text"
              aria-label="Smaller text"
            >
              <Minus size={14} />
            </Button>
            <SizableText
              size="$1"
              minW={24}
              text="center"
              select="none"
              style={{ fontVariantNumeric: 'tabular-nums' }}
              render={<span title="Terminal text size" />}
            >
              {size}
            </SizableText>
            <Button
              variant="ghost"
              size="sm"
              px="$2"
              onPress={() => setSize((n) => clampSize(n + SIZE.step))}
              disabled={size >= SIZE.max}
              title="Larger text"
              aria-label="Larger text"
            >
              <Plus size={14} />
            </Button>
          </XStack>
          <Button
            data-slot="pane-split"
            data-dir="right"
            variant="outline"
            size="sm"
            onPress={() => focus && split('row', focus)}
            disabled={!focus || busy}
            title="Split right"
            aria-label="Split right"
          >
            <Columns2 size={14} />
            {paging ? null : <SizableText size="$1">Right</SizableText>}
          </Button>
          <Button
            data-slot="pane-split"
            data-dir="down"
            variant="outline"
            size="sm"
            onPress={() => focus && split('col', focus)}
            disabled={!focus || busy}
            title="Split down"
            aria-label="Split down"
          >
            <Rows2 size={14} />
            {paging ? null : <SizableText size="$1">Down</SizableText>}
          </Button>
          {end}
        </XStack>
      </XStack>

      {/* The phone's pager. One chip per PAGE, because pages are what you swipe. */}
      {paging && pages > 1 ? (
        <XStack shrink={0} gap="$1" style={{ overflowX: 'auto', overflowY: 'hidden' }}>
          {Array.from({ length: pages }, (_, i) => {
            const first = geo.rects.find((r) => Math.round(r.left / 100) === i);
            const b = first ? bind[first.id] : undefined;
            const name = b ? label(b) : String(i + 1);
            return (
              <Button
                key={i}
                variant="ghost"
                size="sm"
                maxW={160}
                shrink={0}
                bg={i === page ? 'var(--muted)' : 'transparent'}
                onPress={() => {
                  setPage(i);
                  if (first) setFocus(first.id);
                }}
              >
                <SizableText
                  size="$1"
                  numberOfLines={1}
                  ellipsis
                  color={i === page ? '$color' : 'var(--muted-foreground)'}
                >
                  {name}
                </SizableText>
              </Button>
            );
          })}
        </XStack>
      ) : null}

      <YStack
        // The box measures itself, and what measures is a DOM element — so the
        // ref holds one, narrowed where it is set rather than asserted.
        ref={(el) => {
          boxRef.current = el instanceof HTMLElement ? el : null;
        }}
        data-slot="tabs-scroll-container"
        position="relative"
        width="100%"
        flex={1}
        minH={0}
        overflow="hidden"
        rounded="$4"
        borderWidth={1}
        borderColor="$borderColor"
        bg={FRAME[scheme].ground}
      >
        {/* The scroller is inside the box so that what covers the box (the drag
            sheet, the picker) stays put while the panes scroll under it. */}
        <YStack
          ref={(el) => {
            scroller.current = el instanceof HTMLElement ? el : null;
          }}
          position="absolute"
          inset={0}
          style={{ overflowX: scrolls ? 'auto' : 'hidden', overflowY: 'hidden' }}
        >
        <YStack
          position={scrolls ? 'relative' : 'absolute'}
          inset={scrolls ? undefined : 0}
          style={
            paging
              ? {
                  width: `${pages * 100}%`,
                  transform: `translate3d(-${(page * 100) / pages}%,0,0)`,
                  transition: drag ? 'none' : 'transform 220ms cubic-bezier(0.22,1,0.36,1)',
                }
              : scrolls
                ? { width: canvas, height: '100%' }
                : undefined
          }
        >
          {rendered.map((id) => {
            const r = placed.get(id);
            if (!r) return null;
            const b = bind[id]!;
            const on = id === focus;
            const machine = machineOf(b);
            const host = machine ? hostOf(machine) : undefined;
            const title = label(b);
            // One source, whatever the machine. A pane that has no URL yet is a
            // mint still in flight or one that could not be made — a tunnel
            // publishes a terminal and nothing else, so a linked machine has no
            // screen and never gets one.
            // A page's url IS its binding — there is no credential to mint and
            // nothing spent by framing it. Everything else waits for the mint.
            const url = capped.has(id) ? null : b.kind === 'page' ? b.url : address(come[id]);
            // The one way out for a pane whose terminal did not come up — a
            // frame that never said ready, or an address that never arrived.
            // A frame that never said ready is a credential that no longer
            // opens anything — a spent ticket, an aged session — and the URL
            // cannot be reopened, only asked for again. NEVER a sign-in here:
            // the mint IS the sign-in, and sending someone to a second one is
            // what this stopped doing.
            const rescue = () => (
              <Cover gap="$3" bg={FRAME[scheme].ground}>
                <Note>
                  {b.kind === 'screen' ? 'The desktop' : 'The terminal'} did not come up.
                  Reconnect asks for a fresh link to it and tries again.
                </Note>
                <Button variant="outline" minH={44} onPress={() => reconnect(id)}>
                  Reconnect
                </Button>
                {host?.sandbox && onStop ? (
                  <>
                    <Note>
                      {host.machine} is still running and counts against your plan until it
                      is stopped.
                    </Note>
                    {/* The one way to stop: the same question as closing,
                        which warns when the machine keeps no files. */}
                    <Button variant="outline" minH={44} onPress={() => offerStop(host.machine)}>
                      Stop machine
                    </Button>
                  </>
                ) : null}
              </Cover>
            );
            // How a pane on a machine reads, from its come-up (lib/comeup `view`).
            const seen = come[id] ? view(come[id]!, b.kind === 'screen' ? 'screen' : 'shell') : null;
            // A pane on a machine has a come-up from its first effect on; for the
            // one render before that there is nothing to say yet.
            const f = seen?.face ?? 'quiet';
            // Every rect is page-relative; the track is `pages * 100%` wide, so a
            // page occupies `100/pages` of it.
            const left = paging ? r.left / pages : r.left;
            const width = paging ? r.width / pages : r.width;

            return (
              <YStack
                key={id}
                data-slot="terminal-pane"
                onPointerDown={() => setFocus(id)}
                position="absolute"
                overflow="hidden"
                style={{
                  left: `${left}%`,
                  top: `${r.top}%`,
                  width: `${width}%`,
                  height: `${r.height}%`,
                }}
              >
                {/* A pane's name bar. It is chrome around the only thing on the
                    page worth reading, so it is as short as a touch target
                    allows and no shorter — every pixel here is a row of
                    terminal, times the number of panes. */}
                <XStack
                  data-slot="pane-name"
                  data-focused={on ? 'true' : 'false'}
                  height={BAR}
                  shrink={0}
                  items="center"
                  gap="$1.5"
                  px="$2"
                  bg={on ? 'var(--muted)' : 'var(--card)'}
                >
                  {b.kind === 'page' ? (
                    <>
                      <Chip
                        run={() => step(id, -1)}
                        title="Back"
                        disabled={(trail[id]?.at ?? 0) <= 0}
                      >
                        <ArrowLeft size={14} />
                      </Chip>
                      {paging ? null : (
                        <Chip
                          run={() => step(id, 1)}
                          title="Forward"
                          disabled={(trail[id]?.at ?? 0) >= (trail[id]?.urls.length ?? 1) - 1}
                        >
                          <ArrowRight size={14} />
                        </Chip>
                      )}
                      <Chip run={() => reload(id)} title="Reload">
                        <RotateCw size={14} />
                      </Chip>
                      <Address url={b.url} go={(to) => visit(id, to)} />
                    </>
                  ) : (
                    <>
                  <Dot status={b.kind === 'gone' ? 'offline' : (host?.status ?? 'offline')} />
                  <SizableText
                    size="$1"
                    numberOfLines={1}
                    ellipsis
                    color={on ? '$color' : 'var(--muted-foreground)'}
                  >
                    {title}
                  </SizableText>
                    </>
                  )}
                  {host?.sandbox && agent ? (
                    <Chip
                      run={() => setTalking((t) => ({ ...t, [id]: !t[id] }))}
                      title={talking[id] ? 'Hide the AI and take control' : 'Work this machine with AI'}
                      ml={paging ? 'auto' : 0}
                    >
                      <Bot size={14} />
                    </Chip>
                  ) : null}
                  {paging ? null : (
                    <XStack ml="auto" items="center" gap="$1">
                      <Chip run={() => split('row', id)} title="Split right" disabled={busy} data-slot="pane-split" data-dir="right">
                        <Columns2 size={14} />
                      </Chip>
                      <Chip run={() => split('col', id)} title="Split down" disabled={busy} data-slot="pane-split" data-dir="down">
                        <Rows2 size={14} />
                      </Chip>
                    </XStack>
                  )}
                  {/* ONE bare button per row on a phone: globals.css grows every
                      button to 44px on a coarse pointer, so neighbours at a 24px
                      pitch overlap and the LAST wins — close was stealing taps
                      from split. */}
                  <Chip
                    run={() => close(id)}
                    title="Close pane"
                    data-slot="pane-close"
                    ml={paging ? 'auto' : 0}
                  >
                    <X size={paging ? 16 : 14} />
                  </Chip>
                </XStack>

                <XStack flex={1} minH={0} flexDirection={paging ? 'column' : 'row'}>
                <YStack position="relative" flex={1} minH={0} bg={FRAME[scheme].ground}>
                  {url ? (
                    <iframe
                      // One frame per address, so a fresh ticket is a fresh
                      // frame and `spend` sees every load of an address.
                      key={url}
                      data-pane={id}
                      src={url}
                      title={title}
                      // Scripts (a terminal is one), and `allow-same-origin` gives
                      // the frame ITS OWN origin — which ttyd needs for its socket
                      // — never ours. What is withheld is top-navigation and popups.
                      sandbox="allow-scripts allow-same-origin allow-forms"
                      ref={(el) => {
                        frames.current[id] = el;
                      }}
                      onLoad={() => send(id, { type: 'loaded', now: Date.now() })}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        border: 0,
                        background: FRAME[scheme].ground,
                        filter: frameFilter(scheme, on),
                      }}
                    />
                  ) : null}

                  {capped.has(id) ? (
                    <Cover gap="$2">
                      <Note>
                        {streams === 0
                          ? 'Your plan does not stream tabs.'
                          : `Your plan streams ${streams} ${streams === 1 ? 'tab' : 'tabs'} at once.`}{' '}
                        This one is kept and opens when a place frees up or you upgrade.
                      </Note>
                      <Button
                        variant="outline"
                        size="sm"
                        onPress={() => window.open(UPGRADE, '_blank', 'noopener,noreferrer')}
                      >
                        See plans
                      </Button>
                    </Cover>
                  ) : b.kind === 'starting' ? (
                    // The loader lives HERE, in the box the machine is for —
                    // not on the button that asked. It is what tells you the
                    // click landed, and it is where the terminal appears.
                    <Cover gap="$2">
                      <Loader2
                        size={20}
                        color="var(--muted-foreground)"
                        style={{ animation: 'spin 1s linear infinite' }}
                      />
                      <Note>
                        Starting {b.want === 'screen' ? 'a desktop' : 'a machine'}. Its{' '}
                        {b.want === 'screen' ? 'screen' : 'terminal'} opens here.
                      </Note>
                    </Cover>
                  ) : b.kind === 'failed' ? (
                    <Cover gap="$2">
                      <Note>{b.why}</Note>
                      {/* Out of credit is the ONE failure here with a remedy the
                          person already holds: a cloud machine is ours and costs
                          money, a linked one is theirs and costs nothing, and
                          tabs drives both identically. Saying only "insufficient
                          balance" beside a Close button reads as a dead end when
                          the workspace still works. */}
                      {b.unfunded ? (
                        <>
                          <Note>
                            Your plan has no credit for a new cloud computer. Top up, run{' '}
                            <SizableText render="code" size="$1" fontFamily="$mono" color="$color">
                              hanzo link
                            </SizableText>{' '}
                            on a computer of your own to open its shell for free, or start a
                            temporary cloud computer: its files will not be kept when it stops.
                          </Note>
                          <XStack gap="$2" items="center" flexWrap="wrap" justify="center">
                            <Button
                              variant="default"
                              size="sm"
                              onPress={() => window.open('https://hanzo.ai/pay', '_blank')}
                            >
                              Top up balance
                            </Button>
                            {b.start ? (
                              // Never started on its own: the person picks it, in
                              // words that say what it loses.
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onPress={() =>
                                  void startMachine({ kind: b.start!, from: 'button', into: id, temporary: true })
                                }
                              >
                                Start a temporary one (files will not be kept)
                              </Button>
                            ) : null}
                            <Button variant="outline" size="sm" onPress={() => close(id)}>
                              Close pane
                            </Button>
                          </XStack>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" onPress={() => close(id)}>
                          Close pane
                        </Button>
                      )}
                    </Cover>
                  ) : b.kind === 'gone' ? (
                    <Cover gap="$2">
                      <Note>
                        <SizableText size="$1" color="$color">
                          {b.shell.machine}
                        </SizableText>{' '}
                        is offline. The{' '}
                        <SizableText size="$1" color="$color">
                          {b.shell.name}
                        </SizableText>{' '}
                        shell is still there, kept on the machine.
                      </Note>
                      <Button variant="outline" size="sm" onPress={() => close(id)}>
                        Close pane
                      </Button>
                    </Cover>
                  ) : b.kind === 'page' ? (
                    url ? null : (
                      <Cover gap="$2">
                        <Globe size={22} color="var(--muted-foreground)" />
                        <Note>Enter a URL above to open a page.</Note>
                      </Cover>
                    )
                  ) : f === 'starting' ? (
                    // A machine that is starting: its silence is the machine
                    // booting, so it reads as progress, not failure.
                    <Cover gap="$2" bg={FRAME[scheme].ground}>
                      <Loader2
                        size={20}
                        color="var(--muted-foreground)"
                        style={{ animation: 'spin 1s linear infinite' }}
                      />
                      <Note>
                        {seen?.words}
                      </Note>
                    </Cover>
                  ) : f === 'offline' ? (
                    <Cover gap="$2">
                      <Note>
                        <SizableText size="$1" color="$color">
                          {machine}
                        </SizableText>{' '}
                        is offline.
                      </Note>
                      <Button variant="outline" size="sm" onPress={() => close(id)}>
                        Close pane
                      </Button>
                    </Cover>
                  ) : f === 'sign-in' ? (
                    // The machine's own tunnel asked for a sign-in, which a
                    // frame cannot show (the sign-in page refuses to be
                    // framed). Signing in once in the browser sets the
                    // session the frame then uses.
                    <Cover gap="$3" bg={FRAME[scheme].ground}>
                      <Note>Sign in to this machine in your browser first, then try again.</Note>
                      {/* The machine may have left the list since: with no address
                          of its own there is nothing to sign in to, only Try again. */}
                      {host?.base ? (
                        <Button
                          variant="default"
                          minH={44}
                          onPress={() => window.open(host.base, '_blank', 'noopener,noreferrer')}
                        >
                          Sign in in your browser
                        </Button>
                      ) : null}
                      <Button variant="outline" minH={44} onPress={() => reconnect(id)}>
                        Try again
                      </Button>
                    </Cover>
                  ) : f === 'failed' ? (
                    rescue()
                  ) : f === 'waiting' ? (
                    <Cover>
                      <Note>
                        Waiting for{' '}
                        <SizableText size="$1" color="$color">
                          {machine}
                        </SizableText>{' '}
                        to {b.kind === 'screen' ? 'show its screen' : 'serve a terminal'}. It
                        appears here as soon as the machine is up.
                      </Note>
                    </Cover>
                  ) : null}
                </YStack>
                {host?.sandbox && agent && talking[id] !== undefined ? (
                  <AgentPanel
                    open={!!talking[id]}
                    vertical={paging}
                    onHide={() => setTalking((t) => ({ ...t, [id]: false }))}
                    run={(body, onFrame, signal) => agent(host, body, onFrame, signal)}
                  />
                ) : null}
                </XStack>
              </YStack>
            );
          })}

          {geo.dividers.map((d) => {
            const left = paging ? d.left / pages : d.left;
            const width = paging ? d.width / pages : d.width;
            // The hit area stays a thumb wide where a thumb is what lands on it.
            const thick = d.dir === 'row' ? 12 : paging ? 24 : 12;
            return (
              <YStack
                key={d.path.join('') || 'root'}
                onPointerDown={(e: ReactPointerEvent<HTMLElement>) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  setDrag(d);
                }}
                group
                role="separator"
                aria-label="Resize panes"
                aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
                position="absolute"
                z={20}
                bg="transparent"
                cursor={d.dir === 'row' ? 'col-resize' : 'row-resize'}
                x={d.dir === 'row' ? -thick / 2 : 0}
                y={d.dir === 'row' ? 0 : -thick / 2}
                style={{
                  touchAction: 'none',
                  left: `${left}%`,
                  top: `${d.top}%`,
                  width: d.dir === 'row' ? thick : `${width}%`,
                  height: d.dir === 'row' ? `${d.height}%` : thick,
                }}
              >
                {/* A visible grabber: a touch divider you cannot see is one that
                    does not exist. What it LOOKS like and what it CATCHES are
                    separate — the hit area above stays a thumb wide, while the
                    mark is a hairline, because a seam between two terminals
                    should read as a seam and not as a third thing in the
                    window. It brightens on hover, where the pointer already
                    is. */}
                <YStack
                  aria-hidden
                  pointerEvents="none"
                  position="absolute"
                  l="50%"
                  t="50%"
                  x={d.dir === 'row' ? -0.5 : -12}
                  y={d.dir === 'row' ? -12 : -0.5}
                  width={d.dir === 'row' ? 1 : 24}
                  height={d.dir === 'row' ? 24 : 1}
                  rounded={9999}
                  bg="var(--white-20)"
                  $group-hover={{ bg: 'var(--white-40)' }}
                />
              </YStack>
            );
          })}
        </YStack>
        </YStack>

        {drag ? (
          <YStack
            position="absolute"
            inset={0}
            z={30}
            cursor={drag.dir === 'row' ? 'col-resize' : 'row-resize'}
          />
        ) : null}

        {picking ? (
          <YStack
            position="absolute"
            inset={0}
            z={40}
            items="center"
            justify="center"
            p="$4"
            bg="rgb(0 0 0 / 0.7)"
          >
            <Picker
              ask={picking.kind === 'dev' ? 'Where should this shell run?' : 'Which desktop?'}
              hosts={picking.from}
              onPick={(m) => {
                open(picking.make(m), picking.at);
                setPicking(null);
              }}
              onNew={
                onLaunch
                  ? () => {
                      void startMachine({ kind: picking.kind, at: picking.at, from: 'picker' });
                      setPicking(null);
                    }
                  : undefined
              }
              onCancel={() => setPicking(null)}
            />
          </YStack>
        ) : null}
        {question}
      </YStack>
    </YStack>
  );
}

/**
 * A question that interrupts: the stack's AlertDialog, so focus moves in and
 * opens on the safe answer, Escape is that answer, Tab cannot reach the
 * terminals behind it, and focus goes back where it was. The safe answer is
 * always Cancel's slot; the one that starts or stops something is the Action.
 */
function Question({
  q,
  onAnswer,
}: {
  q: Ask;
  onAnswer: (yes: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  // The Action's press and the dialog's own close both arrive on a yes; the
  // close is read a tick later so it can never overrule the press.
  const picked = useRef(false);
  const yes = () => {
    picked.current = true;
    onAnswer(true, remember);
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) setTimeout(() => picked.current || onAnswer(false, false), 0);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{q.title}</AlertDialogTitle>
          <AlertDialogDescription>{q.say}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{q.no ?? q.yes}</AlertDialogCancel>
          {q.no ? <AlertDialogAction onPress={yes}>{q.yes}</AlertDialogAction> : null}
        </AlertDialogFooter>
        {/* After the answers, so the safe one is the first thing focused. */}
        {q.remember ? (
          <XStack items="center" gap="$2">
            <Checkbox
              id="hanzo-tabs-remember"
              checked={remember}
              onCheckedChange={(c: boolean | 'indeterminate') => setRemember(c === true)}
            />
            <Label htmlFor="hanzo-tabs-remember" size="$1">
              {q.remember}
            </Label>
          </XStack>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One labelled button in the action row.
 *
 * It carries no busy state and no failure of its own, and that is the point: a
 * button that asks for a machine opens the pane the machine is for, so the wait
 * and the reason it failed both belong to that pane. Keeping a spinner here too
 * would say the same thing twice, in the one place you are not looking.
 */
function Act({
  run,
  icon,
  label,
  disabled,
}: {
  run: () => void;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" size="sm" shrink={0} onPress={run} disabled={disabled}>
      {icon}
      <SizableText size="$1">{label}</SizableText>
    </Button>
  );
}

/** Where should this shell run? Only ever shown when there is a real choice,
 *  and a new machine, where one can be started, is the first of them. */
function Picker({
  ask = 'Where should this shell run?',
  hosts,
  onPick,
  onNew,
  onCancel,
}: {
  /** The question, in the words of what is being opened. */
  ask?: string;
  hosts: TerminalHost[];
  onPick: (machine: string) => void;
  onNew?: () => void;
  onCancel: () => void;
}) {
  return (
    <YStack
      width="100%"
      maxW={320}
      p="$3"
      rounded="$4"
      borderWidth={1}
      borderColor="$borderColor"
      bg="var(--card)"
    >
      <SizableText mb="$2" size="$1" color="var(--muted-foreground)">
        {ask}
      </SizableText>
      <YStack render="ul" gap="$1">
        {onNew ? (
          <YStack render="li">
            <Button
              variant="ghost"
              width="100%"
              minH={44}
              justify="flex-start"
              gap="$2"
              px="$2"
              onPress={onNew}
            >
              <Cloud size={14} color="var(--muted-foreground)" />
              <SizableText size="$2" numberOfLines={1} ellipsis>
                New cloud computer
              </SizableText>
            </Button>
          </YStack>
        ) : null}
        {hosts.map((h) => (
          <YStack key={h.machine} render="li">
            <Button
              variant="ghost"
              width="100%"
              minH={44}
              justify="flex-start"
              gap="$2"
              px="$2"
              onPress={() => onPick(h.machine)}
            >
              <Dot status={h.status} />
              <SizableText size="$2" numberOfLines={1} ellipsis>
                {h.machine}
              </SizableText>
              {h.label ? (
                <SizableText
                  ml="auto"
                  size="$1"
                  numberOfLines={1}
                  ellipsis
                  color="var(--muted-foreground)"
                >
                  {h.label}
                </SizableText>
              ) : null}
            </Button>
          </YStack>
        ))}
      </YStack>
      <Button variant="ghost" size="sm" width="100%" mt="$2" onPress={onCancel}>
        <SizableText size="$1" color="var(--muted-foreground)">
          Cancel
        </SizableText>
      </Button>
    </YStack>
  );
}

export default Workspace;
