/**
 * How a pane on a machine comes up: ONE state machine, and nothing else decides.
 *
 * A pane's terminal (or screen) is up only when the page in its frame SAYS so
 * (`READY` in panes.ts). Before that it passes through a few states, and three
 * rounds of defects came from deciding them in several places on several
 * clocks. So the decision lives here, pure: `step` takes a state and an event
 * and answers the next state, and `due` says what the one runner in the
 * workspace must do — ask for an address, or wake at a time. The runner does
 * that and nothing else, and drops the state (and its timer) when the pane
 * closes, is capped, or the workspace unmounts.
 *
 * THE ONE CLOCK is `deadline`, set when the come-up begins. A machine this pane
 * sees starting — the list calls it pending, or this workspace started it —
 * gets ALLOWANCE from the moment the pane first saw it so. One already running
 * gets LOAD_LIMIT, cut to DEADLINE once its frame has loaded. Past the
 * deadline every state that is not `ready` is `failed`: none can last forever.
 *
 * An address is asked for ONLY while the list says the machine is running.
 * While it is pending nothing is minted; the list's own poll moves it on.
 */
import { ALLOWANCE, DEADLINE, LOAD_LIMIT } from './panes';

/** What the machine list says about the pane's machine. */
export type Listed = 'running' | 'pending' | 'gone';

type Clock = {
  /** When this come-up fails if it has not reached `ready`. */
  deadline: number;
  /** Whether the pane saw its machine starting, which earns it ALLOWANCE. */
  starting: boolean;
  /** What the list last said, so a retry never asks a machine gone back to
   *  pending, and a pane given up on knows when its machine has come up. */
  listed: Listed;
  /** Which attempt this is, from the ONE counter the runner holds: every new
   *  come-up draws a fresh one, so an answer to an earlier one is ignored and
   *  never mistaken for the current one. */
  epoch: number;
};

export type Come =
  /** The list does not say running yet (pending, or not listed yet). `tries`
   *  counts the asks already made, so the next one is a new attempt. */
  | ({ at: 'machine'; tries: number } & Clock)
  /** An address is being asked for; `tries` counts the attempts. */
  | ({ at: 'minting'; tries: number } & Clock)
  /** That ask failed; it is asked again at `until`, if the list still says running. */
  | ({ at: 'backoff'; tries: number; until: number } & Clock)
  /** The frame has its address and is loading it. */
  | ({ at: 'loading'; url: string; loaded: boolean } & Clock)
  | { at: 'ready'; url: string; epoch: number }
  | {
      at: 'failed';
      /** `timeout`: the deadline passed. `mint`: no address could be had.
       *  `sign-in`: a linked machine's tunnel wants a sign-in first.
       *  `gone`: the machine is not in the list. */
      why: 'timeout' | 'mint' | 'sign-in' | 'gone';
      url?: string;
      listed: Listed;
      epoch: number;
    };

export type ComeEvent =
  /** `epoch` is a fresh number from the runner's counter, taken if this list
   *  update begins a new come-up. */
  | { type: 'list'; listed: Listed; now: number; epoch: number }
  | { type: 'minted'; url: string; epoch: number; tries: number }
  | { type: 'mint-failed'; signIn: boolean; epoch: number; tries: number; now: number }
  | { type: 'loaded'; now: number }
  | { type: 'ready' }
  | { type: 'tick'; now: number }
  | { type: 'reconnect'; listed: Listed; now: number; epoch: number };

/** How long each retry of a failed ask waits; its length is how many retries
 *  there are. Only a machine that is starting is retried, and only inside its
 *  allowance. */
export const BACKOFF = [2_000, 4_000, 8_000] as const;

/** A come-up beginning, for a pane on a machine the list calls `listed`.
 *  `started` is whether this workspace started that machine. */
export function begin(now: number, listed: Listed, started: boolean, epoch: number): Come {
  const starting = started || listed === 'pending';
  const clock = { deadline: now + (starting ? ALLOWANCE : LOAD_LIMIT), starting, listed, epoch };
  if (listed === 'running') return { at: 'minting', tries: 1, ...clock };
  if (starting) return { at: 'machine', tries: 0, ...clock };
  return { at: 'failed', why: 'gone', listed, epoch };
}

export function step(c: Come, e: ComeEvent): Come {
  if (e.type === 'reconnect') return begin(e.now, e.listed, false, e.epoch);
  if (c.at === 'ready') return c;
  if (c.at === 'failed') {
    if (e.type === 'list') {
      // A machine back in the list is a fresh start for its pane; so is one the
      // pane timed out on while it was pending, once the list says it runs —
      // a change that happens once per start, so this cannot loop.
      const back = c.why === 'gone' && e.listed !== 'gone';
      const up = c.why === 'timeout' && !c.url && c.listed === 'pending' && e.listed === 'running';
      if (back || up) return begin(e.now, e.listed, false, e.epoch);
      return e.listed === c.listed ? c : { ...c, listed: e.listed };
    }
    // A frame that was given up on and then says it is up IS up: the failure
    // must not be drawn over a working terminal.
    if (c.why === 'timeout' && c.url && e.type === 'ready') return { at: 'ready', url: c.url, epoch: c.epoch };
    return c;
  }
  if ((e.type === 'tick' || e.type === 'list' || e.type === 'mint-failed' || e.type === 'loaded') && e.now >= c.deadline) {
    const listed = e.type === 'list' ? e.listed : c.listed;
    return { at: 'failed', why: 'timeout', url: c.at === 'loading' ? c.url : undefined, listed, epoch: c.epoch };
  }
  switch (e.type) {
    case 'list': {
      const seen = { ...c, listed: e.listed };
      if (e.listed === 'pending' && !c.starting) {
        // First seen starting: the allowance counts from now.
        return { ...seen, starting: true, deadline: Math.max(c.deadline, e.now + ALLOWANCE) };
      }
      if (c.at === 'machine' && e.listed === 'running') return { ...seen, at: 'minting', tries: c.tries + 1 };
      if (e.listed === 'gone' && !c.starting && c.at !== 'loading') {
        return { at: 'failed', why: 'gone', listed: 'gone', epoch: c.epoch };
      }
      return e.listed === c.listed ? c : seen;
    }
    case 'minted':
      return c.at === 'minting' && e.epoch === c.epoch && e.tries === c.tries
        ? { at: 'loading', url: e.url, loaded: false, deadline: c.deadline, starting: c.starting, listed: c.listed, epoch: c.epoch }
        : c;
    case 'mint-failed': {
      if (c.at !== 'minting' || e.epoch !== c.epoch || e.tries !== c.tries) return c;
      if (e.signIn) return { at: 'failed', why: 'sign-in', listed: c.listed, epoch: c.epoch };
      const wait = BACKOFF[c.tries - 1];
      if (c.starting && wait !== undefined && e.now + wait < c.deadline) {
        return { ...c, at: 'backoff', until: e.now + wait };
      }
      return { at: 'failed', why: 'mint', listed: c.listed, epoch: c.epoch };
    }
    case 'loaded':
      if (c.at !== 'loading') return c;
      // A running machine's page has loaded and owes its word within DEADLINE;
      // a starting one keeps its allowance, since its shell may still be booting.
      return { ...c, loaded: true, deadline: c.starting ? c.deadline : Math.min(c.deadline, e.now + DEADLINE) };
    case 'ready':
      return c.at === 'loading' ? { at: 'ready', url: c.url, epoch: c.epoch } : c;
    case 'tick': {
      if (c.at !== 'backoff' || e.now < c.until) return c;
      // Ask again only of a machine the list still says runs; one gone back to
      // pending waits for the list, as any pending machine does.
      const { until: _until, ...rest } = c;
      return c.listed === 'running' ? { ...rest, at: 'minting', tries: c.tries + 1 } : { ...rest, at: 'machine' };
    }
  }
}

/** What the runner must do for a state: ask for an address (once per attempt,
 *  keyed by `key`), and when to wake it with a tick. */
export function due(c: Come): { mint?: string; wake?: number } {
  switch (c.at) {
    case 'minting':
      return { mint: `${c.epoch}:${c.tries}`, wake: c.deadline };
    case 'backoff':
      return { wake: Math.min(c.until, c.deadline) };
    case 'machine':
    case 'loading':
      return { wake: c.deadline };
    default:
      return {};
  }
}

/** The address the frame should load, if it has one. A frame given up on
 *  keeps it, under the failure, so it can still say it is up. */
export const address = (c: Come | undefined): string | null =>
  c && (c.at === 'loading' || c.at === 'ready' || c.at === 'failed') ? (c.url ?? null) : null;

/**
 * What the person sees over the pane. `starting` for every state before ready
 * on a machine that is starting, with words that say which step it is on;
 * `waiting` while a running machine's address is fetched; nothing while its
 * frame loads; and the failure that matches the reason.
 */
export function view(
  c: Come,
  want: 'shell' | 'screen',
): { face: 'starting' | 'waiting' | 'quiet' | 'failed' | 'sign-in' | 'offline'; words?: string } {
  const face = want === 'screen' ? 'screen' : 'terminal';
  switch (c.at) {
    case 'ready':
      return { face: 'quiet' };
    case 'failed':
      return { face: c.why === 'sign-in' ? 'sign-in' : c.why === 'gone' ? 'offline' : 'failed' };
    case 'machine':
      return { face: 'starting', words: 'Starting your machine…' };
    case 'minting':
    case 'backoff':
      return c.starting
        ? { face: 'starting', words: `Your machine is running. Opening its ${face}…` }
        : { face: 'waiting' };
    case 'loading':
      return c.starting ? { face: 'starting', words: `Waiting for its ${face} to answer…` } : { face: 'quiet' };
  }
}

/**
 * Whether any pane is waiting on the list to say its machine runs — the one
 * time the list is worth reading quickly (lib/fleet `every`). The workspace
 * says so on this event; the fleet listens. A host needs to wire nothing.
 */
export const WAITING_EVENT = 'hanzo:tabs-waiting';

export const waiting = (all: Readonly<Record<string, Come>>): boolean =>
  Object.values(all).some((c) => c.at === 'machine');
