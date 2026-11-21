import { BACKOFF, type Come, type ComeEvent, type Listed, address, begin, due, step, view } from '@/lib/comeup';
import { ALLOWANCE, DEADLINE, LOAD_LIMIT } from '@/lib/panes';

/**
 * The come-up machine, as a table: every state crossed with every event, then
 * the scenarios earlier reviews found, each walked from its beginning.
 */
const T = 1_000_000;
const A = ALLOWANCE;
const L = LOAD_LIMIT;
const D = DEADLINE;
const at = T + 1_000;
const run = { deadline: T + L, starting: false, listed: 'running', epoch: 1 } as const;
const boot = { deadline: T + A, starting: true, listed: 'running', epoch: 1 } as const;

const S = {
  'machine (starting)': { at: 'machine', tries: 0, ...boot, listed: 'pending' },
  'minting (running)': { at: 'minting', tries: 1, ...run },
  'minting (starting)': { at: 'minting', tries: 1, ...boot },
  'backoff (starting)': { at: 'backoff', tries: 1, until: T + 2_000, ...boot },
  'loading (running)': { at: 'loading', url: 'u', loaded: false, ...run },
  'loaded (running)': { at: 'loading', url: 'u', loaded: true, ...run, deadline: T + D },
  'loading (starting)': { at: 'loading', url: 'u', loaded: false, ...boot },
  ready: { at: 'ready', url: 'u', epoch: 1 },
  'failed (timeout, with an address)': { at: 'failed', why: 'timeout', url: 'u', listed: 'running', epoch: 1 },
  'failed (timeout while pending, no address)': { at: 'failed', why: 'timeout', listed: 'pending', epoch: 1 },
  'failed (gone)': { at: 'failed', why: 'gone', listed: 'gone', epoch: 1 },
  'failed (mint)': { at: 'failed', why: 'mint', listed: 'running', epoch: 1 },
  'failed (sign-in)': { at: 'failed', why: 'sign-in', listed: 'running', epoch: 1 },
} satisfies Record<string, Come>;
type Name = keyof typeof S;

// The list and Reconnect carry a FRESH number from the runner's one counter.
const E = {
  'list running': { type: 'list', listed: 'running', now: at, epoch: 9 },
  'list pending': { type: 'list', listed: 'pending', now: at, epoch: 9 },
  'list gone': { type: 'list', listed: 'gone', now: at, epoch: 9 },
  minted: { type: 'minted', url: 'v', epoch: 1, tries: 1 },
  'mint failed': { type: 'mint-failed', signIn: false, epoch: 1, tries: 1, now: at },
  'mint wants sign-in': { type: 'mint-failed', signIn: true, epoch: 1, tries: 1, now: at },
  loaded: { type: 'loaded', now: at },
  ready: { type: 'ready' },
  'tick early': { type: 'tick', now: at },
  'tick at backoff end': { type: 'tick', now: T + 2_000 },
  'tick past the allowance': { type: 'tick', now: T + A },
  reconnect: { type: 'reconnect', listed: 'running', now: at, epoch: 9 },
} satisfies Record<string, ComeEvent>;
type Ev = keyof typeof E;

// What a fresh start looks like, numbered from the event.
const anew = (listed: 'running' | 'pending'): Come =>
  listed === 'running'
    ? { at: 'minting', tries: 1, deadline: at + L, starting: false, listed, epoch: 9 }
    : { at: 'machine', tries: 0, deadline: at + A, starting: true, listed, epoch: 9 };
const timedOut = (listed: Listed, url?: string): Come => ({ at: 'failed', why: 'timeout', url, listed, epoch: 1 });

/** The whole resulting state for each pair; a pair not named leaves the state
 *  exactly as it was. */
const changes: Record<Name, Partial<Record<Ev, Come>>> = {
  'machine (starting)': {
    'list running': { ...S['machine (starting)'], at: 'minting', tries: 1, listed: 'running' },
    'list gone': { ...S['machine (starting)'], listed: 'gone' },
    'tick past the allowance': timedOut('pending'),
    reconnect: anew('running'),
  },
  'minting (running)': {
    'list pending': { ...S['minting (running)'], listed: 'pending', starting: true, deadline: at + A },
    'list gone': { at: 'failed', why: 'gone', listed: 'gone', epoch: 1 },
    minted: { at: 'loading', url: 'v', loaded: false, ...run },
    'mint failed': { at: 'failed', why: 'mint', listed: 'running', epoch: 1 },
    'mint wants sign-in': { at: 'failed', why: 'sign-in', listed: 'running', epoch: 1 },
    'tick past the allowance': timedOut('running'),
    reconnect: anew('running'),
  },
  'minting (starting)': {
    'list pending': { ...S['minting (starting)'], listed: 'pending' },
    'list gone': { ...S['minting (starting)'], listed: 'gone' },
    minted: { at: 'loading', url: 'v', loaded: false, ...boot },
    'mint failed': { at: 'backoff', tries: 1, until: at + BACKOFF[0], ...boot },
    'mint wants sign-in': { at: 'failed', why: 'sign-in', listed: 'running', epoch: 1 },
    'tick past the allowance': timedOut('running'),
    reconnect: anew('running'),
  },
  'backoff (starting)': {
    'list pending': { ...S['backoff (starting)'], listed: 'pending' },
    'list gone': { ...S['backoff (starting)'], listed: 'gone' },
    'tick at backoff end': { at: 'minting', tries: 2, ...boot },
    'tick past the allowance': timedOut('running'),
    reconnect: anew('running'),
  },
  'loading (running)': {
    'list pending': { ...S['loading (running)'], listed: 'pending', starting: true, deadline: at + A },
    'list gone': { ...S['loading (running)'], listed: 'gone' },
    loaded: { ...S['loading (running)'], loaded: true, deadline: at + D },
    ready: { at: 'ready', url: 'u', epoch: 1 },
    'tick past the allowance': timedOut('running', 'u'),
    reconnect: anew('running'),
  },
  'loaded (running)': {
    'list pending': { ...S['loaded (running)'], listed: 'pending', starting: true, deadline: at + A },
    'list gone': { ...S['loaded (running)'], listed: 'gone' },
    ready: { at: 'ready', url: 'u', epoch: 1 },
    'tick past the allowance': timedOut('running', 'u'),
    reconnect: anew('running'),
  },
  'loading (starting)': {
    'list pending': { ...S['loading (starting)'], listed: 'pending' },
    'list gone': { ...S['loading (starting)'], listed: 'gone' },
    loaded: { ...S['loading (starting)'], loaded: true },
    ready: { at: 'ready', url: 'u', epoch: 1 },
    'tick past the allowance': timedOut('running', 'u'),
    reconnect: anew('running'),
  },
  ready: { reconnect: anew('running') },
  'failed (timeout, with an address)': {
    'list pending': { ...S['failed (timeout, with an address)'], listed: 'pending' },
    'list gone': { ...S['failed (timeout, with an address)'], listed: 'gone' },
    ready: { at: 'ready', url: 'u', epoch: 1 },
    reconnect: anew('running'),
  },
  'failed (timeout while pending, no address)': {
    'list running': anew('running'),
    'list gone': { ...S['failed (timeout while pending, no address)'], listed: 'gone' },
    reconnect: anew('running'),
  },
  'failed (gone)': {
    'list running': anew('running'),
    'list pending': anew('pending'),
    reconnect: anew('running'),
  },
  'failed (mint)': {
    'list pending': { ...S['failed (mint)'], listed: 'pending' },
    'list gone': { ...S['failed (mint)'], listed: 'gone' },
    reconnect: anew('running'),
  },
  'failed (sign-in)': {
    'list pending': { ...S['failed (sign-in)'], listed: 'pending' },
    'list gone': { ...S['failed (sign-in)'], listed: 'gone' },
    reconnect: anew('running'),
  },
};

describe('every state crossed with every event, compared whole', () => {
  for (const name of Object.keys(S) as Name[]) {
    for (const ev of Object.keys(E) as Ev[]) {
      const want = changes[name][ev] ?? S[name];
      it(`${name} + ${ev} → ${want.at}${'why' in want ? ` (${want.why})` : ''}`, () => {
        expect(step(S[name], E[ev])).toEqual(want);
      });
    }
  }
});

describe('every attempt has its own number', () => {
  it('a machine back in the list, then Reconnect: each a fresh attempt, and an answer to an old one is ignored', () => {
    let c: Come = { at: 'failed', why: 'gone', listed: 'gone', epoch: 1 };
    c = step(c, { type: 'list', listed: 'running', now: T, epoch: 5 });
    expect(due(c).mint).toBe('5:1');
    c = step(c, { type: 'reconnect', listed: 'running', now: T + 1, epoch: 6 });
    expect(due(c).mint).toBe('6:1');
    // An answer for the number the old code would have given (old + 1) is not this one.
    expect(step(c, { type: 'minted', url: 'stale', epoch: 2, tries: 1 })).toBe(c);
    expect(step(c, { type: 'minted', url: 'stale', epoch: 5, tries: 1 })).toBe(c);
    expect(step(c, { type: 'minted', url: 'fresh', epoch: 6, tries: 1 })).toMatchObject({ at: 'loading', url: 'fresh' });
  });
});

describe('a retry never asks a machine the list says is pending again', () => {
  it('goes back to waiting for the list when its wait ends', () => {
    let c: Come = S['backoff (starting)'];
    c = step(c, { type: 'list', listed: 'pending', now: at, epoch: 9 });
    c = step(c, { type: 'tick', now: T + 2_000 });
    expect(c).toEqual({ at: 'machine', tries: 1, ...boot, listed: 'pending' });
    expect(due(c).mint).toBeUndefined();
  });

  it('asks AGAIN, as a new attempt, once the list says it runs: never the key it already asked with', () => {
    const first = due(S['minting (starting)']).mint;
    let c: Come = step(S['minting (starting)'], { type: 'mint-failed', signIn: false, epoch: 1, tries: 1, now: at });
    c = step(c, { type: 'list', listed: 'pending', now: at + 1, epoch: 9 });
    c = step(c, { type: 'tick', now: at + BACKOFF[0] });
    c = step(c, { type: 'list', listed: 'running', now: at + BACKOFF[0] + 1, epoch: 9 });
    expect(c).toMatchObject({ at: 'minting', tries: 2, epoch: 1 });
    expect(due(c).mint).toBe('1:2');
    expect(due(c).mint).not.toBe(first);
  });
});

describe('a pane timed out while its machine was pending moves on when the list says it runs', () => {
  it('once: the same news again changes nothing, so it cannot loop', () => {
    const c = step(S['failed (timeout while pending, no address)'], E['list running']);
    expect(c).toEqual(anew('running'));
    const failedAgain: Come = { at: 'failed', why: 'timeout', listed: 'running', epoch: 9 };
    expect(step(failedAgain, { type: 'list', listed: 'running', now: at, epoch: 10 })).toBe(failedAgain);
  });
});

/** Walk a pane from its beginning through events, the way the runner would. */
const walk = (c: Come, ...es: ComeEvent[]) => es.reduce(step, c);

describe('the one clock', () => {
  it('gives a machine already running LOAD_LIMIT, cut to DEADLINE once its frame loads', () => {
    const c = walk(begin(T, 'running', false, 1), { type: 'minted', url: 'u', epoch: 1, tries: 1 });
    expect(due(c).wake).toBe(T + LOAD_LIMIT);
    expect(due(step(c, { type: 'loaded', now: T + 500 })).wake).toBe(T + 500 + DEADLINE);
  });

  it('gives a machine this pane sees starting ALLOWANCE, from when it first saw it — reload included', () => {
    // After a reload nobody remembers who started it; the list's `pending` is enough.
    expect(due(begin(T, 'pending', false, 1)).wake).toBe(T + ALLOWANCE);
    // A running pane that then sees its machine pending gets the allowance from then.
    const c = step(begin(T, 'running', false, 1), { type: 'list', listed: 'pending', now: T + 5_000, epoch: 99 });
    expect(due(c).wake).toBe(T + 5_000 + ALLOWANCE);
  });

  it('keeps a starting machine its allowance after the frame loads, since its shell may still boot', () => {
    const c = walk(begin(T, 'running', true, 1), { type: 'minted', url: 'u', epoch: 1, tries: 1 }, { type: 'loaded', now: T + 1 });
    expect(due(c).wake).toBe(T + ALLOWANCE);
  });

  it('wakes every state that is not ready or failed, so none can last forever', () => {
    for (const c of Object.values(S) as Come[]) {
      if (c.at === 'ready' || c.at === 'failed') expect(due(c).wake).toBeUndefined();
      else expect(due(c).wake).toBeLessThanOrEqual(c.deadline);
    }
  });
});

describe('asking for an address', () => {
  it('asks only while the list says running: a pending machine mints nothing', () => {
    expect(due(begin(T, 'pending', false, 1)).mint).toBeUndefined();
    expect(due(begin(T, 'running', false, 1)).mint).toBe('1:1');
  });

  it('retries a starting machine a bounded number of times, with backoff, inside the allowance', () => {
    let c: Come = begin(T, 'running', true, 1);
    let now = T;
    const asked: number[] = [];
    for (;;) {
      if (c.at === 'minting') {
        asked.push(now);
        c = step(c, { type: 'mint-failed', signIn: false, epoch: 1, tries: c.tries, now });
      } else if (c.at === 'backoff') {
        now = c.until;
        c = step(c, { type: 'tick', now });
      } else break;
    }
    expect(asked).toHaveLength(BACKOFF.length + 1);
    expect(c).toMatchObject({ at: 'failed', why: 'mint' });
  });

  it('does not retry past the allowance: a failure near its end is the failure (round 3, finding 1)', () => {
    const c = step(
      { at: 'minting', tries: 1, ...boot } as Come,
      { type: 'mint-failed', signIn: false, epoch: 1, tries: 1, now: T + ALLOWANCE - 1_000 },
    );
    expect(c).toMatchObject({ at: 'failed', why: 'mint' });
  });

  it('does not retry a machine that was already running', () => {
    expect(step(S['minting (running)'], E['mint failed'])).toMatchObject({ at: 'failed', why: 'mint' });
  });

  it('ignores an answer to an earlier attempt or an earlier come-up', () => {
    const c = S['minting (starting)'];
    expect(step(c, { type: 'minted', url: 'old', epoch: 0, tries: 1 })).toBe(c);
    expect(step(c, { type: 'minted', url: 'old', epoch: 1, tries: 2 })).toBe(c);
  });
});

describe('the scenarios the reviews named', () => {
  it('a pending machine after a reload reads as starting, then opens once the list says running', () => {
    let c = begin(T, 'pending', false, 1);
    expect(view(c, 'shell').face).toBe('starting');
    c = walk(c, { type: 'list', listed: 'running', now: T + 30_000, epoch: 99 }, { type: 'minted', url: 'u', epoch: 1, tries: 1 });
    expect(address(c)).toBe('u');
    expect(step(c, { type: 'ready' }).at).toBe('ready');
  });

  it('a machine pending past its allowance ends failed, with no address ever asked for', () => {
    const c = walk(begin(T, 'pending', false, 1), { type: 'list', listed: 'pending', now: T + 30_000, epoch: 99 }, {
      type: 'tick',
      now: T + ALLOWANCE,
    });
    expect(c).toMatchObject({ at: 'failed', why: 'timeout' });
    expect(view(c, 'shell').face).toBe('failed');
  });

  it('a frame that never says ready on a running machine fails DEADLINE after its load, and a late ready lifts it', () => {
    let c = walk(begin(T, 'running', false, 1), { type: 'minted', url: 'u', epoch: 1, tries: 1 }, { type: 'loaded', now: T });
    c = step(c, { type: 'tick', now: T + DEADLINE });
    expect(c).toMatchObject({ at: 'failed', why: 'timeout', url: 'u' });
    expect(address(c)).toBe('u');
    expect(step(c, { type: 'ready' }).at).toBe('ready');
  });

  it('a linked machine whose tunnel wants a sign-in says so, and Reconnect begins again', () => {
    const c = step(begin(T, 'running', false, 1), { type: 'mint-failed', signIn: true, epoch: 1, tries: 1, now: T });
    expect(view(c, 'shell').face).toBe('sign-in');
    expect(step(c, { type: 'reconnect', listed: 'running', now: T + 9, epoch: 2 })).toMatchObject({ at: 'minting', epoch: 2 });
  });

  it('a machine not in the list reads offline, and comes back when it is listed again', () => {
    const c = begin(T, 'gone', false, 1);
    expect(view(c, 'shell').face).toBe('offline');
    expect(step(c, { type: 'list', listed: 'running', now: T, epoch: 99 }).at).toBe('minting');
  });

  it('a machine this workspace just started but the list has not caught up with reads as starting', () => {
    expect(view(begin(T, 'gone', true, 1), 'screen')).toEqual({ face: 'starting', words: 'Starting your machine…' });
  });

  it('a running machine shows no cover while its frame loads, and the waiting words while its address is fetched', () => {
    expect(view(S['loading (running)'], 'shell').face).toBe('quiet');
    expect(view(S['minting (running)'], 'shell').face).toBe('waiting');
  });
});
