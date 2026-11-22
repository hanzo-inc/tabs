import {
  type Binding,
  DEADLINE,
  DEFAULT_SHELL,
  DOT,
  READY,
  isReady,
  label,
  machineOf,
  mintName,
  revive,
  safeName,
  shellUrl,
  tabItems,
  termCommand,
  web,
} from '@/lib/panes';
import { append, pane, paneIds } from '@/lib/tiles';

/**
 * A pane's URL is the whole "new shell" mechanism, so the rules about it are the
 * feature. `--url-arg` hands the query to a command running on someone's machine;
 * everything here is about that not being a way in.
 */
describe('a shell is named by the URL, and the name is bounded', () => {
  it('keeps a name the machine will accept', () => {
    expect(safeName('build')).toBe('build');
    expect(safeName('deploy-2')).toBe('deploy_2'.replace('_', '-'));
  });

  it('strips what tmux would read as syntax', () => {
    // `;` is tmux's command separator: `new -A -s x; whoami` is two commands.
    expect(safeName('x; whoami')).toBe('xwhoami');
    expect(safeName('a b c')).toBe('abc');
    expect(safeName('../../etc')).toBe('etc');
  });

  it('bounds the length and never yields nothing', () => {
    expect(safeName('a'.repeat(200))).toHaveLength(32);
    expect(safeName('')).toBe(DEFAULT_SHELL);
    expect(safeName('💀')).toBe(DEFAULT_SHELL);
  });

  it('sets exactly ONE arg — a second is a second argument to a real shell', () => {
    const u = new URL(shellUrl('https://x.share.hanzo.ai', 'build'));
    expect(u.searchParams.getAll('arg')).toEqual(['build']);
    // Even when the base already carries one.
    const v = new URL(shellUrl('https://x.share.hanzo.ai/?arg=evil', 'build'));
    expect(v.searchParams.getAll('arg')).toEqual(['build']);
  });

  it('sanitises through the URL too, not only at the edge', () => {
    const u = new URL(shellUrl('https://x.share.hanzo.ai', 'x; whoami'));
    expect(u.searchParams.get('arg')).toBe('xwhoami');
  });

  it('leaves a base it cannot parse alone rather than corrupting it', () => {
    expect(shellUrl('not a url', 'build')).toBe('not a url');
  });
});

describe('a machine’s next shell has a name nobody has to invent', () => {
  it('the first is the default', () => {
    expect(mintName([])).toBe(DEFAULT_SHELL);
  });

  it('then numbers, skipping what is open', () => {
    expect(mintName([DEFAULT_SHELL])).toBe('shell-2');
    expect(mintName([DEFAULT_SHELL, 'shell-2'])).toBe('shell-3');
    expect(mintName([DEFAULT_SHELL, 'shell-3'])).toBe('shell-2');
  });

  it('reuses the default once it is free — closing a pane frees its name', () => {
    // tmux new -A attaches, so reopening the name reopens the SAME shell.
    expect(mintName(['shell-2'])).toBe(DEFAULT_SHELL);
  });
});

/**
 * A terminal is present only when it SAYS so.
 *
 * This shipped wrong twice by inference. The guess was that a refused frame stays
 * at `about:blank` — same-origin, readable, empty — while a real load throws on
 * `contentDocument`. The common case is neither: the frame follows the tunnel to
 * its OAuth gate, the gate redirects to hanzo.id, hanzo.id answers
 * `frame-ancestors 'none'`, and the browser swaps in `chrome-error://chromewebdata/`
 * — which throws EXACTLY like a healthy cross-origin load. So every genuinely
 * blocked terminal read as fine, and the user got an opaque black rectangle with
 * the way out hidden underneath it.
 */
describe('a framed page announces itself, and silence is the rescue', () => {
  it('recognises our pages and nothing else', () => {
    // Both of them: a terminal and a screen fail the same way and are proved
    // the same way, so one predicate answers for both.
    for (const source of READY) expect(isReady({ source, ready: true })).toBe(true);
    expect(READY).toEqual(['hanzo-term', 'hanzo-screen']);
    // Everything a hostile or unrelated frame might post.
    expect(isReady({ source: 'other-app' })).toBe(false);
    expect(isReady({ ready: true })).toBe(false);
    expect(isReady('hanzo-term')).toBe(false);
    expect(isReady(null)).toBe(false);
    expect(isReady(undefined)).toBe(false);
  });

  it('waits long enough that a slow connect is not called dead', () => {
    expect(DEADLINE).toBeGreaterThanOrEqual(3000);
  });
});

/**
 * A pane shows a machine, one of two ways: its shell or its screen. Both are
 * bound to a machine and neither is a special case of the other — which is the
 * whole reason the binding says which it is instead of the URL implying it.
 */
describe('a pane bound to a screen is still bound to a machine', () => {
  it('names the machine whichever face it is showing', () => {
    expect(machineOf({ kind: 'shell', shell: { machine: 'desk', name: 'hanzo' } })).toBe('desk');
    expect(machineOf({ kind: 'screen', machine: 'desk' })).toBe('desk');
    expect(machineOf({ kind: 'gone', shell: { machine: 'desk', name: 'hanzo' } })).toBe('desk');
  });

  it('names the machine and which of its faces, so a pane needs no key', () => {
    // The shape: <machine> · <face>. Both halves are numbered, so neither has
    // to be recognised as the odd one — `tabs · hanzo` was two bare nouns and
    // told you neither which box nor which shell.
    expect(label({ kind: 'shell', shell: { machine: 'cloud-2', name: 'shell-1' } })).toBe(
      'cloud-2 · shell-1',
    );
    expect(label({ kind: 'screen', machine: 'desk-1' })).toBe('desk-1 · desk');
  });

  it('says what it is showing, so the header and the frame agree', () => {
    expect(label({ kind: 'shell', shell: { machine: 'cloud-2', name: 'build' } })).toBe(
      'cloud-2 · build',
    );
    expect(label({ kind: 'screen', machine: 'desk-1' })).toBe('desk-1 · desk');
  });
});

/**
 * A machine that does not exist yet still gets a pane.
 *
 * The pane is opened by the CLICK and settled by the ANSWER, because
 * provisioning a cloud machine is tens of seconds and waiting for it before
 * drawing anything leaves the workspace looking like the click missed. So a
 * binding has to be able to say "a machine is coming" and "none came".
 */
describe('a pane can be waiting for a machine', () => {
  it('is bound to no machine while one is being made', () => {
    // Load-bearing: the mint effect keys on machineOf, so a starting pane
    // naming a machine would send a ticket request for a box that is not there.
    expect(machineOf({ kind: 'starting', want: 'shell' })).toBeNull();
    expect(machineOf({ kind: 'starting', want: 'screen' })).toBeNull();
    expect(machineOf({ kind: 'failed', why: 'out of capacity' })).toBeNull();
  });

  it('says which kind of machine it is waiting for', () => {
    expect(label({ kind: 'starting', want: 'shell' })).toBe('Starting a machine');
    expect(label({ kind: 'starting', want: 'screen' })).toBe('Starting a desktop');
    expect(label({ kind: 'failed', why: 'out of capacity' })).toBe('Could not start');
  });

  // A saved layout of four columns: what each one held when the tab closed.
  const tree = append(append(append(pane('a'), 'b'), 'c'), 'd');
  const known = new Set(['desk']);

  it('closes a pane whose launch died with the page, and one that had failed', () => {
    const { tree: t, bind } = revive(
      tree,
      {
        a: { kind: 'shell', shell: { machine: 'desk', name: 'build' } },
        b: { kind: 'starting', want: 'shell' },
        c: { kind: 'failed', why: 'out of capacity' },
        d: { kind: 'empty' }, // what an older version saved for a split never filled
      },
      known,
    );
    expect(t && paneIds(t)).toEqual(['a']);
    expect(Object.keys(bind)).toEqual(['a']);
  });

  it('keeps what can show something, and a gone shell comes back as a shell', () => {
    const { tree: t, bind } = revive(
      tree,
      {
        a: { kind: 'shell', shell: { machine: 'desk', name: 'build' } },
        b: { kind: 'screen', machine: 'desk' },
        c: { kind: 'gone', shell: { machine: 'desk', name: 'old' } },
        d: { kind: 'page', url: 'https://hanzo.ai' },
      },
      known,
    );
    expect(t && paneIds(t)).toEqual(['a', 'b', 'c', 'd']);
    expect(bind.c).toEqual({ kind: 'shell', shell: { machine: 'desk', name: 'old' } });
  });

  it('closes panes on machines that are not there, and leaves nothing when none survives', () => {
    expect(revive(tree, { a: { kind: 'screen', machine: 'gone-box' } }, known).tree).toBeNull();
  });
});


/**
 * A browser pane frames the open web, which makes it the one pane whose
 * address comes from a person's keyboard rather than from a mint. Two rules
 * follow, and both are here.
 */
describe('a browser pane', () => {
  it('takes a bare host to mean https', () => {
    expect(web('news.ycombinator.com')).toBe('https://news.ycombinator.com/');
    expect(web('  hanzo.ai  ')).toBe('https://hanzo.ai/');
  });

  it('keeps a scheme that was typed', () => {
    expect(web('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(web('https://hanzo.ai/v1')).toBe('https://hanzo.ai/v1');
  });

  it('REFUSES a scheme it will not frame', () => {
    // These reach an iframe src, where they are script in THIS document rather
    // than a page in the frame. Refusing is the answer: a browser pane that
    // quietly loaded one would be an injection with a text field in front of it.
    expect(web('javascript:alert(1)')).toBeNull();
    expect(web('JavaScript:alert(1)')).toBeNull();
    expect(web('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(web('vbscript:msgbox(1)')).toBeNull();
    expect(web('file:///etc/passwd')).toBeNull();
    expect(web('blob:https://hanzo.ai/x')).toBeNull();
  });

  it('has nothing to open for nothing typed', () => {
    expect(web('')).toBeNull();
    expect(web('   ')).toBeNull();
  });

  it('names itself by its host', () => {
    expect(label({ kind: 'page', url: 'https://www.hanzo.ai/x?y=1' })).toBe('hanzo.ai');
    expect(label({ kind: 'page', url: '' })).toBe('New tab');
  });

  it('is on no machine', () => {
    expect(machineOf({ kind: 'page', url: 'https://hanzo.ai' })).toBeNull();
  });

  it('comes back on the address it was left on', () => {
    // Nothing was running, so nothing is stale: a url survives a reload the way
    // a shell name does.
    const page = { kind: 'page' as const, url: 'https://hanzo.ai' };
    expect(revive(pane('p'), { p: page }, new Set()).bind.p).toEqual(page);
  });

});

/** What a host's tab strip hears (`hanzo:tabs-state`): one item per open pane, in order. */
describe('the open panes as a host lists them', () => {
  const bind: Record<string, Binding> = {
    a: { kind: 'shell', shell: { machine: 'cloud-1', name: 'shell-1' } },
    b: { kind: 'screen', machine: 'desk-1' },
    c: { kind: 'page', url: 'https://news.ycombinator.com/' },
    d: { kind: 'gone', shell: { machine: 'old', name: 'shell-1' } },
    e: { kind: 'starting', want: 'shell' },
    f: { kind: 'failed', why: 'no' },
  };
  const status = (m: string) => ({ 'cloud-1': 'running', 'desk-1': 'pending' })[m];

  it('names each pane as the pane names itself, in the order given, marking the focused one', () => {
    const items = tabItems(['b', 'a', 'c'], bind, 'a', status);
    expect(items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(items.map((i) => i.title)).toEqual([label(bind.b!), label(bind.a!), label(bind.c!)]);
    expect(items.map((i) => i.active)).toEqual([false, true, false]);
  });

  it('reads status from the machine list, so a dot can follow it', () => {
    const items = tabItems(['a', 'b', 'c'], bind, null, status);
    expect(items.map((i) => i.status)).toEqual(['running', 'pending', 'online']);
  });

  it('calls a pane with no machine behind it offline, and one starting pending', () => {
    const items = tabItems(['d', 'e', 'f'], bind, null, status);
    expect(items.map((i) => i.status)).toEqual(['offline', 'pending', 'offline']);
    expect(tabItems(['a'], bind, null, () => undefined)[0]!.status).toBe('offline');
  });

  it('skips an id with no binding, and has no active tab with no focus', () => {
    const items = tabItems(['zz', 'a'], bind, null, status);
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(items.some((i) => i.active)).toBe(false);
  });
});

describe('what a terminal page may ask of its pane', () => {
  it('is a split in a direction, or a close', () => {
    expect(termCommand({ source: 'hanzo-term', split: 'row' })).toEqual({ split: 'row' });
    expect(termCommand({ source: 'hanzo-term', split: 'col' })).toEqual({ split: 'col' });
    expect(termCommand({ source: 'hanzo-term', close: true })).toEqual({ close: true });
  });

  it('is nothing else: no other source, direction or truthy stand-in', () => {
    expect(termCommand({ source: 'other', close: true })).toBeNull();
    expect(termCommand({ source: 'hanzo-term', split: 'diagonal' })).toBeNull();
    expect(termCommand({ source: 'hanzo-term', close: 'yes' })).toBeNull();
    expect(termCommand({ source: 'hanzo-term', ready: true })).toBeNull();
    expect(termCommand(null)).toBeNull();
    expect(termCommand('hanzo-term')).toBeNull();
  });

  it('never makes a ready message a command, nor a command the word that a pane is ready', () => {
    expect(termCommand({ source: 'hanzo-term', ready: true })).toBeNull();
    // A command carries the terminal's source, so it would also pass `isReady`:
    // the workspace reads commands FIRST, and this is why it must.
    expect(isReady({ source: 'hanzo-term', split: 'row' })).toBe(true);
  });
});
