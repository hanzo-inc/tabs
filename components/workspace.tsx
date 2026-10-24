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
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Columns2,
  Globe,
  Loader2,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Rows2,
  X,
} from 'lucide-react';
import { Button, Input, Paragraph, SizableText, XStack, YStack } from '@hanzo/ui';

import {
  type TerminalHost,
} from '../lib/panes';
import {
  type Dir,
  type Geometry,
  type Path,
  type Tile,
  closePane,
  geometry,
  pageGeometry,
  pane,
  paneIds,
  setRatio,
  splitPane,
  stableOrder,
  stackFor,
} from '../lib/tiles';
// One import, and it is a PURE READING of an error — no origin, no token, no
// request. The workspace still holds no credential; what it gains is the
// platform's own word for "no money", which is the one failure whose remedy
// differs from every other.
import { unfunded } from '../lib/api';
import {
  DEADLINE,
  DOT,
  type Binding,
  isReady,
  proves,
  label,
  machineOf,
  mintName,
  rescued,
  web,
  restore,
} from '../lib/panes';
import { UPGRADE, over } from '../lib/plan';

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
  streams = null,
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
  /** Start a cloud machine of one class, and answer the name it goes by here. */
  onLaunch?: (kind: 'dev' | 'desktop') => Promise<string>;
  /** How many tabs the plan lets stream at once (`lib/plan.ts`): 0 none, N a cap,
   *  -1 no cap, null not told — which enforces nothing. */
  streams?: number | null;
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
  const [bind, setBind] = useState<Record<string, Binding>>({});
  const seq = useRef(0);
  const [ready, setReady] = useState(false);

  // Restore, or open the first machine's default shell. A saved pane whose machine
  // is gone is KEPT and marked — tmux is still holding that session, and a layout
  // is the reader's, not a function of someone else's uptime.
  useEffect(() => {
    if (ready) return;
    const saved = load();
    if (saved?.tree) {
      seq.current = saved.seq ?? 0;
      const known = new Set(live.map((h) => h.machine));
      setBind(
        Object.fromEntries(
          Object.entries(saved.bind).map(([id, b]) => [
            id,
            b.kind === 'shell' && !known.has(b.shell.machine)
              ? ({ kind: 'gone', shell: b.shell } as Binding)
              : restore(b),
          ]),
        ),
      );
      setTile(saved.tree);
    } else if (live[0]) {
      const id = `p${seq.current++}`;
      setBind({ [id]: { kind: 'shell', shell: { machine: live[0].machine, name: mintName([]) } } });
      setTile(pane(id));
    }
    setReady(true);
  }, [live, ready]);

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

  /** Open a NEW pane showing `what`, beside `target` — or as the whole layout.
   *  Answers with the pane's id, so a caller still waiting on what goes in it
   *  can settle that one box later. */
  const open = useCallback((what: Binding, dir: Dir | null, target: string | null) => {
    const id = `p${seq.current++}`;
    setBind((b) => ({ ...b, [id]: what }));
    setTile((t) => (t && target && dir ? splitPane(t, target, dir, id) : (t ?? pane(id))));
    setFocus(id);
    return id;
  }, []);

  /** Put `what` in a pane that is still open. A pane closed while its machine
   *  was starting stays closed — an answer arriving late must not reopen a box
   *  someone shut. */
  const settle = useCallback((id: string, what: Binding) => {
    setBind((b) => (b[id] ? { ...b, [id]: what } : b));
  }, []);

  /** Start a machine and open it. The point of the button is what you get to
   *  look at: a machine that arrives with nothing framed on it is a row in a
   *  list, and you would have to go and ask for the thing you already asked for. */
  const launch = useCallback(
    (kind: 'dev' | 'desktop') => {
      if (!onLaunch) return;
      const want = kind === 'desktop' ? 'screen' : 'shell';
      // The pane opens on the CLICK, not on the answer. Provisioning is the
      // long part, so waiting for it before drawing anything is a workspace
      // that sits unchanged for the whole minute you are waiting.
      const id = open({ kind: 'starting', want }, focus ? 'row' : null, focus);
      onLaunch(kind)
        .then((machine) => settle(id, want === 'screen' ? screenOn(machine) : shellOn(machine)))
        .catch((e) =>
          settle(id, {
            kind: 'failed',
            why: e instanceof Error ? e.message : 'could not start a machine',
            unfunded: unfunded(e),
          }),
        );
    },
    [onLaunch, open, settle, focus, shellOn, screenOn],
  );

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
  }, [ready]);

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

  const pages = paged?.pages ?? 1;
  const [page, setPage] = useState(0);
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);
  useEffect(() => {
    // Following the focused pane keeps the strip and the view in agreement.
    if (paged && focus && paged.page[focus] !== undefined) setPage(paged.page[focus]!);
  }, [paged, focus]);

  // ---- dragging a divider -------------------------------------------------
  const [drag, setDrag] = useState<{ path: Path; dir: Dir } | null>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return;
      // In the paged projection the track is `pages * 100%` wide and shifted, so a
      // horizontal drag is measured against ONE page, not the whole track.
      const frac =
        drag.dir === 'row'
          ? (e.clientX - r.left) / r.width
          : (e.clientY - r.top) / r.height;
      setTile((t) => (t ? setRatio(t, drag.path, frac) : t));
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag]);

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
  const [alive, setAlive] = useState<Record<string, boolean>>({});
  const [waited, setWaited] = useState<Record<string, boolean>>({});
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});

  const [size, setSize] = useState(loadSize);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isReady(e.data)) return;
      // The sender identifies the pane: a message is trusted only when it comes
      // from the window of a frame this workspace actually rendered. The origin
      // is not pinned because every machine publishes on its own tunnel host.
      for (const [id, el] of Object.entries(frames.current)) {
        if (el && e.source === el.contentWindow) {
          setAlive((a) => (a[id] ? a : { ...a, [id]: true }));
          el.contentWindow?.postMessage({
            source: 'hanzo-term',
            fontSize: size,
            fontFamily: "'Geist Mono', 'Zen Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }, '*');
          return;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [size]);

  // The reader's type size, told to every terminal that is up.
  //
  // It runs on `alive` as well as on the size itself, so a pane that boots after
  // the setting was chosen is told as soon as it says it is ready — the same
  // signal, used for the same reason, rather than a second notion of when a
  // frame can be spoken to. A pane that never answers is never sent to, which is
  // right: there is nothing there to hear it.
  useEffect(() => {
    window.localStorage.setItem(SIZE_KEY, String(size));
    for (const [id, el] of Object.entries(frames.current)) {
      if (alive[id]) {
        el?.contentWindow?.postMessage({
          source: 'hanzo-term',
          fontSize: size,
          fontFamily: "'Geist Mono', 'Zen Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }, '*');
      }
    }
  }, [size, alive]);

  const probe = useCallback((id: string, el: HTMLIFrameElement | null) => {
    frames.current[id] = el;
    if (!el) return;
    // Give the terminal a moment to boot before calling it absent — a rescue that
    // flashes over every pane on every load is its own defect.
    const t = setTimeout(() => setWaited((w) => (w[id] ? w : { ...w, [id]: true })), DEADLINE);
    return () => clearTimeout(t);
  }, []);

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

  // Which panes owe us a word that they came up. A page on the open web owes
  // none, so its silence is not a failure to report.
  const proving = useMemo(
    () => Object.fromEntries(Object.entries(bind).map(([id, b]) => [id, proves(b)])),
    [bind],
  );
  const refused = useMemo(() => rescued(waited, alive, proving), [waited, alive, proving]);

  // A pick is "which machine", and what to MAKE of the one picked comes with
  // the question — so the same picker asks for a shell's machine and a
  // screen's, and neither knows about the other.
  const [picking, setPicking] = useState<null | {
    make: (m: string) => Binding;
    from: TerminalHost[];
    dir: Dir | null;
    target: string | null;
  }>(null);
  const rendered = useMemo(() => order.filter((id) => bind[id]), [order, bind]);
  /** The panes past what the plan streams. They are kept and shown, never minted. */
  const capped = useMemo(() => over(rendered, bind, streams), [rendered, bind, streams]);

  // A PANE'S URL IS MINTED, NEVER DERIVED — for every machine, not only the
  // ones we start. Minted per PANE and kept until that pane reconnects, because
  // what the mint returns is spent: a sandbox's ticket by the frame's first
  // load, a tunnel's session by nothing, but both are asked for with a
  // credential this component deliberately does not hold. Re-deriving on render
  // would hand the iframe a dead one.
  //
  // In-flight ids are tracked outside state so a re-render mid-mint cannot start
  // a second mint for the same pane.
  const [minted, setMinted] = useState<Record<string, string>>({});
  const minting = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!mint) return;
    for (const id of rendered) {
      const b = bind[id];
      const m = b && (b.kind === 'shell' || b.kind === 'screen') ? machineOf(b) : null;
      if (!b || !m) continue;
      const h = hostOf(m);
      if (!h || minted[id] || minting.current.has(id) || capped.has(id)) continue;
      minting.current.add(id);
      mint(h, b)
        .then((src) => setMinted((m) => ({ ...m, [id]: src })))
        // A pane whose URL never arrived is offered the way out immediately,
        // rather than waiting out a deadline for a frame that was never made.
        .catch(() => setWaited((w) => ({ ...w, [id]: true })))
        .finally(() => minting.current.delete(id));
    }
  }, [rendered, bind, hostOf, mint, minted, capped]);

  /** Reconnect a pane: forget the spent URL and the frame's history so the mint
   *  effect runs again with a fresh credential and the deadline re-arms. */
  const reconnect = useCallback((id: string) => {
    const drop = <T,>(o: Record<string, T>): Record<string, T> => {
      const { [id]: _gone, ...rest } = o;
      return rest;
    };
    setMinted(drop);
    setAlive(drop);
    setWaited(drop);
  }, []);

  if (live.length === 0 && !tile) {
    return (
      <YStack
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
            <Act run={() => launch('dev')} icon={<Cloud size={14} />} label="New cloud machine" />
            <Act run={() => launch('desktop')} icon={<Monitor size={14} />} label="New desktop" />
          </XStack>
        ) : null}
      </YStack>
    );
  }

  /** Never make someone choose from a set of one. */
  const openHere = (make: (m: string) => Binding, from: TerminalHost[], dir: Dir | null, target: string | null) => {
    if (from.length === 1) open(make(from[0]!.machine), dir, target);
    else setPicking({ make, from, dir, target });
  };

  /** A shell goes on any live machine. */
  const openShell = (dir: Dir | null, target: string | null) => openHere(shellOn, live, dir, target);

  /** A page needs no machine, so it needs no picker and no mint — the pane
   *  opens empty and the address is the whole of what it wants. */
  const openPage = (dir: Dir | null, target: string | null) =>
    open({ kind: 'page', url: '' }, dir, target);

  /** A screen goes only where there IS one — and where there is none, the
   *  button starts the machine that has one. One press, one meaning: show me a
   *  desktop. */
  const openScreen = (dir: Dir | null, target: string | null) =>
    watchable.length ? openHere(screenOn, watchable, dir, target) : launch('desktop');

  return (
    <YStack height="100%" width="100%" gap="$2.5" p="$3">
      {/* One row. Actions, not a status report. */}
      <XStack shrink={0} items="center" gap="$2">
        {start}
        <Act
          run={() => openShell(focus ? 'row' : null, focus)}
          icon={<Plus size={14} />}
          label="New shell"
        />
        {/* One button for the screen, whether or not a machine with one exists
            yet: with a desktop live it opens it, without one it starts it. The
            alternative — a disabled button beside a second button that makes it
            work — is two controls for one intention. */}
        {watchable.length || onLaunch ? (
          <Act
            run={() => openScreen(focus ? 'row' : null, focus)}
            icon={<Monitor size={14} />}
            label="Desktop"
          />
        ) : null}
        <Act
          run={() => openPage(focus ? 'row' : null, focus)}
          icon={<Globe size={14} />}
          label="Browse"
        />
        {onLaunch ? (
          <Act
            run={() => launch('dev')}
            icon={<Cloud size={14} />}
            label="New cloud machine"
          />
        ) : null}
        <XStack ml="auto" shrink={0} items="center" gap="$1.5">
          {/* Type size. Two buttons and the number they move — a stepper IS the
              setting, so there is no panel to open and nothing to find. It reads
              its own state, which a slider or a menu would each need a second
              affordance to do. */}
          <XStack
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
            variant="outline"
            size="sm"
            onPress={() => focus && openShell('row', focus)}
            disabled={!focus}
            title="Split right"
          >
            <Columns2 size={14} />
            {paging ? null : <SizableText size="$1">Right</SizableText>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() => focus && openShell('col', focus)}
            disabled={!focus}
            title="Split down"
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
        position="relative"
        width="100%"
        flex={1}
        minH={0}
        overflow="hidden"
        rounded="$4"
        borderWidth={1}
        borderColor="$borderColor"
        bg="black"
      >
        <YStack
          position="absolute"
          inset={0}
          style={
            paging
              ? {
                  width: `${pages * 100}%`,
                  transform: `translate3d(-${(page * 100) / pages}%,0,0)`,
                  transition: drag ? 'none' : 'transform 220ms cubic-bezier(0.22,1,0.36,1)',
                }
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
            const url = capped.has(id) ? null : b.kind === 'page' ? b.url : (minted[id] ?? null);
            // Every rect is page-relative; the track is `pages * 100%` wide, so a
            // page occupies `100/pages` of it.
            const left = paging ? r.left / pages : r.left;
            const width = paging ? r.width / pages : r.width;

            return (
              <YStack
                key={id}
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
                  {paging ? null : (
                    <XStack ml="auto" items="center" gap="$1">
                      <Chip run={() => openShell('row', id)} title="Split right">
                        <Columns2 size={14} />
                      </Chip>
                      <Chip run={() => openShell('col', id)} title="Split down">
                        <Rows2 size={14} />
                      </Chip>
                    </XStack>
                  )}
                  {/* ONE bare button per row on a phone: globals.css grows every
                      button to 44px on a coarse pointer, so neighbours at a 24px
                      pitch overlap and the LAST wins — close was stealing taps
                      from split. */}
                  <Chip
                    run={() => doClose(id)}
                    title="Close pane"
                    ml={paging ? 'auto' : 0}
                  >
                    <X size={paging ? 16 : 14} />
                  </Chip>
                </XStack>

                <YStack position="relative" flex={1} minH={0} bg="black">
                  {url ? (
                    <iframe
                      data-pane={id}
                      src={url}
                      title={title}
                      // Scripts (a terminal is one), and `allow-same-origin` gives
                      // the frame ITS OWN origin — which ttyd needs for its socket
                      // — never ours. What is withheld is top-navigation and popups.
                      sandbox="allow-scripts allow-same-origin allow-forms"
                      ref={(el) => probe(id, el)}
                      onLoad={(e: SyntheticEvent<HTMLIFrameElement>) =>
                        probe(id, e.currentTarget)
                      }
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        border: 0,
                        background: '#000',
                        filter: on ? undefined : 'brightness(0.65)',
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
                  ) : b.kind === 'empty' ? (
                    <Cover p="$3">
                      <Picker
                        hosts={live}
                        onPick={(m) =>
                          setBind((s) => ({
                            ...s,
                            [id]: { kind: 'shell', shell: { machine: m, name: mintName(takenOn(m)) } },
                          }))
                        }
                        onCancel={() => doClose(id)}
                      />
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
                            A cloud machine is ours and costs credit. Top up your balance or run{' '}
                            <SizableText render="code" size="$1" fontFamily="$mono" color="$color">
                              hanzo link
                            </SizableText>{' '}
                            on your own machine to open its shell for free.
                          </Note>
                          <XStack gap="$2" items="center">
                            <Button
                              variant="default"
                              size="sm"
                              onPress={() => window.open('https://hanzo.ai/pay', '_blank')}
                            >
                              Top up balance
                            </Button>
                            <Button variant="outline" size="sm" onPress={() => doClose(id)}>
                              Close pane
                            </Button>
                          </XStack>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" onPress={() => doClose(id)}>
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
                        shell is still there — tmux is holding it.
                      </Note>
                      <Button variant="outline" size="sm" onPress={() => doClose(id)}>
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
                  ) : !url ? (
                    // No tunnel to frame — a box still coming up, or a link that
                    // stopped serving. Both mean wait, and NEITHER is the OAuth
                    // gate: without this the pane falls through to the rescue,
                    // which offers to sign you in to a terminal at `#`.
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
                  ) : refused[id] ? (
                    // A frame that never said ready is a credential that no
                    // longer opens anything — a spent ticket, an aged session —
                    // and the URL cannot be reopened, only asked for again.
                    // NEVER a sign-in here: the mint IS the sign-in, and sending
                    // someone to a second one is what this stopped doing.
                    <Cover gap="$3" bg="black">
                      <Note>
                        {b.kind === 'screen' ? 'The desktop' : 'The terminal'} did not come up.
                        Reconnecting asks for a fresh credential and tries again.
                      </Note>
                      <Button variant="outline" minH={44} onPress={() => reconnect(id)}>
                        Reconnect
                      </Button>
                    </Cover>
                  ) : null}
                </YStack>
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
                  setDrag({ path: d.path, dir: d.dir });
                }}
                group
                role="separator"
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
              hosts={picking.from}
              onPick={(m) => {
                open(picking.make(m), picking.dir, picking.target);
                setPicking(null);
              }}
              onCancel={() => setPicking(null)}
            />
          </YStack>
        ) : null}
      </YStack>
    </YStack>
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
function Act({ run, icon, label }: { run: () => void; icon: ReactNode; label: string }) {
  return (
    <Button variant="outline" size="sm" shrink={0} onPress={run}>
      {icon}
      <SizableText size="$1">{label}</SizableText>
    </Button>
  );
}

/** Where should this shell run? Only ever shown when there is a real choice. */
function Picker({
  hosts,
  onPick,
  onCancel,
}: {
  hosts: TerminalHost[];
  onPick: (machine: string) => void;
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
        Where should this shell run?
      </SizableText>
      <YStack render="ul" gap="$1">
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
