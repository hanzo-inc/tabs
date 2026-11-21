/**
 * Whether a new cloud computer may start, decided apart from starting it.
 *
 * A new machine costs money on the person's plan, so every way of asking for
 * one — a toolbar button, a split, a picker, the host's menu, the temporary
 * machine offered when credit runs out — comes through ONE start path in the
 * workspace, and that path asks these functions what to do. Nothing here
 * touches the DOM, the network or storage it was not handed, so each answer is
 * tested on its own.
 */

/** The classes of cloud machine the workspace starts. */
export type Kind = 'dev' | 'desktop' | 'browser';

/** Everything the person must be told before a start, and which control asked.
 *  It is what a host's own confirm receives (`confirmLease`), so a host that
 *  asks instead of the workspace can say all of it. */
export type StartAsk = {
  kind: Kind;
  /** A machine with no kept disk: its files are lost when it stops. */
  temporary: boolean;
  /** The plan's limit on streamed tabs is reached, so the new machine would run
   *  (and bill) behind the "Your plan streams N tabs" cover, unseen. */
  beyond: boolean;
  /** The plan's limit on streamed tabs: 0 none, N a cap, -1 no cap, null not told. */
  limit: number | null;
  /** `menu` is the host's own (`hanzo:tabs-action`). */
  from: 'button' | 'split' | 'menu' | 'picker';
  /** When the workspace stops waiting for the answer, in ms since the epoch
   *  (`Date.now()`'s clock). A host's own question should close then and say
   *  nothing started: a yes after it starts nothing. */
  expires: number;
};

/**
 * What the start path does with a request.
 *
 * `ignore` while another start is in flight: one at a time, from the press to
 * the machine's answer, so a double-click is one machine. `host` when the host
 * owns the question, and then it is the ONLY asker. Otherwise the workspace
 * asks, unless the person said not to for this.
 */
export function decide(o: { busy: boolean; host: boolean; quiet: boolean }): 'ignore' | 'host' | 'ask' | 'go' {
  if (o.busy) return 'ignore';
  if (o.host) return 'host';
  return o.quiet ? 'go' : 'ask';
}

/**
 * Whether "Don't ask again" may cover this start, and so whether to offer it.
 *
 * Never for a temporary machine, which loses its files and is chosen in those
 * words each time; never while the plan has said nothing, since then there is
 * no limit to lean on (`limit` is `null`); and never when the new machine would
 * not be seen — a plan that streams no tabs, or one whose tabs are all in use.
 * It is kept per account, so with no account it cannot be kept at all.
 */
export function mayRemember(ask: StartAsk, account: string | null | undefined): boolean {
  return !!account && !ask.temporary && ask.limit !== null && ask.limit !== 0 && !ask.beyond;
}

/** Whether a start may go without its question: the person said so, for a
 *  start that saying so may cover. */
export function silent(remembered: boolean, ask: StartAsk, account: string | null | undefined): boolean {
  return remembered && mayRemember(ask, account);
}

/** Where "Don't ask again" is kept: this browser's storage, or none. */
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KINDS: readonly Kind[] = ['dev', 'desktop', 'browser'];

/** One answer per account and per class of machine, so saying it for shells
 *  says nothing about desktops, and another person on this browser is asked. */
const quietKey = (account: string, kind: Kind) => `hanzo.tabs.start.quiet.v2:${account}:${kind}`;

/** The classes this account said not to be asked about. Storage that cannot
 *  be read remembers nothing, which is the side that asks. */
export function quietKinds(store: Store | null, account: string | null | undefined): Kind[] {
  if (!store || !account) return [];
  try {
    return KINDS.filter((k) => store.getItem(quietKey(account, k)) === '1');
  } catch {
    return [];
  }
}

export function remember(store: Store | null, account: string | null | undefined, kind: Kind): void {
  if (!store || !account) return;
  try {
    store.setItem(quietKey(account, kind), '1');
  } catch {
    /* not kept: the next start asks, which is the safe side */
  }
}

/** Ask again before every start, for every class, on this account. */
export function forget(store: Store | null, account: string | null | undefined): void {
  if (!store || !account) return;
  for (const k of KINDS) {
    try {
      store.removeItem(quietKey(account, k));
    } catch {
      /* unreadable storage remembers nothing anyway */
    }
  }
}

/** How long a host's confirm may take to answer. Past it the start is dropped,
 *  so a confirm that never answers cannot hold the workspace for good, and an
 *  answer that arrives after it starts nothing. */
export const HOST_PATIENCE = 120_000;

/** A host's answer, as a yes or a no: only a plain `true` before `expires`
 *  (the ask's own, so host and workspace share one deadline) is a yes. A
 *  throw, a rejection, any other value, or a late answer is a no. */
export function answerBy(answer: () => unknown, expires: number): Promise<boolean> {
  return new Promise((done) => {
    const late = setTimeout(() => done(false), Math.max(0, expires - Date.now()));
    Promise.resolve()
      .then(answer)
      .then(
        (a) => a === true,
        () => false,
      )
      .then((yes) => {
        clearTimeout(late);
        done(yes);
      });
  });
}

const NOUN: Record<Kind, string> = {
  dev: 'cloud computer',
  desktop: 'cloud computer with a desktop',
  browser: 'cloud computer with a browser',
};

/** Why a machine started now would not be seen. */
const unseen = (limit: number | null) =>
  limit === 0
    ? 'Your plan does not stream tabs, so you will not see it, though it still runs and counts against your plan.'
    : `Your plan streams ${limit} ${limit === 1 ? 'tab' : 'tabs'} at once and they are all open, so it would run where you cannot see it until a place frees up.`;

/** The question the workspace asks before a start, in the words of the start,
 *  and — where it may be kept — the "Don't ask again" that says what it covers. */
export function startQuestion(
  ask: StartAsk,
  account?: string | null,
): { title: string; say: string; yes: string; no: string; remember?: string } {
  const what = ask.temporary ? `temporary ${NOUN[ask.kind]}` : NOUN[ask.kind];
  return {
    remember: mayRemember(ask, account)
      ? `Don't ask again before starting a new ${NOUN[ask.kind]}, for this account in this browser`
      : undefined,
    title: `Start a new ${what}?`,
    say:
      `This starts another ${what} on your plan. It keeps running until you stop it.` +
      (ask.temporary ? ' It keeps no files: everything on it is lost when it stops.' : '') +
      (ask.beyond ? ` ${unseen(ask.limit)}` : ''),
    yes: 'Start it',
    no: 'Cancel',
  };
}

/**
 * The question before a cloud computer stops: after its last pane closed, or
 * from the Stop button of a pane that could not reach it. Keeping it is the
 * safe answer and sits in the slot focused first. A temporary machine keeps no
 * disk, so stopping one is deleting its files, and the question says so in its
 * button as well as its sentence. Without a way to stop it here (`canStop`),
 * it is a notice that it is still running.
 */
export function stopQuestion(
  machine: string,
  o: { temporary: boolean; canStop: boolean },
): { title: string; say: string; yes: string; no?: string } {
  const running = `${machine} is still running on your plan.`;
  if (!o.canStop) return { title: `${machine} is still running`, say: `${running} It keeps running until it is stopped.`, yes: 'OK' };
  return {
    title: `Stop ${machine}?`,
    say: o.temporary
      ? `${running} It is temporary: stopping it deletes its files, and they cannot be got back.`
      : `${running} Stopping it keeps its files.`,
    yes: o.temporary ? 'Stop and lose its files' : 'Stop it',
    no: 'Keep it running',
  };
}
