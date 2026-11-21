import {
  HOST_PATIENCE,
  type StartAsk,
  answerBy,
  decide,
  forget,
  mayRemember,
  quietKinds,
  remember,
  silent,
  startQuestion,
  stopQuestion,
} from '@/lib/start';

const ask = (over: Partial<StartAsk> = {}): StartAsk => ({
  kind: 'dev',
  temporary: false,
  beyond: false,
  limit: -1,
  from: 'button',
  expires: 0,
  ...over,
});

describe('the one start path', () => {
  it('ignores a second start while one is in flight, whoever would have answered', () => {
    expect(decide({ busy: true, host: false, quiet: true })).toBe('ignore');
    expect(decide({ busy: true, host: true, quiet: false })).toBe('ignore');
  });

  it('lets a host that asks be the only asker', () => {
    expect(decide({ busy: false, host: true, quiet: true })).toBe('host');
    expect(decide({ busy: false, host: true, quiet: false })).toBe('host');
  });

  it('asks, unless the person said not to', () => {
    expect(decide({ busy: false, host: false, quiet: false })).toBe('ask');
    expect(decide({ busy: false, host: false, quiet: true })).toBe('go');
  });
});

describe("a host's answer", () => {
  afterEach(() => jest.useRealTimers());

  it('is a yes only when it is exactly true', async () => {
    expect(await answerBy(() => true, Date.now() + HOST_PATIENCE)).toBe(true);
    expect(await answerBy(async () => true, Date.now() + HOST_PATIENCE)).toBe(true);
    for (const a of [false, 'yes', 1, undefined, null, {}]) expect(await answerBy(() => a, Date.now() + HOST_PATIENCE)).toBe(false);
  });

  it('is a no when the confirm throws or rejects', async () => {
    expect(
      await answerBy(() => {
        throw new Error('broken');
      }, Date.now() + HOST_PATIENCE),
    ).toBe(false);
    expect(await answerBy(() => Promise.reject(new Error('broken')), Date.now() + HOST_PATIENCE)).toBe(false);
  });

  it('is a yes up to the last moment before the ask expires', async () => {
    jest.useFakeTimers();
    let yes: (v: boolean) => void = () => {};
    // The deadline the workspace enforces is the ask's own `expires`: the same
    // number the host is handed, so the two cannot disagree.
    const expires = Date.now() + HOST_PATIENCE;
    const host = new Promise<boolean>((r) => (yes = r));
    const said = answerBy(() => host, expires);
    jest.advanceTimersByTime(expires - Date.now() - 1);
    yes(true);
    expect(await said).toBe(true);
  });

  it('is a no at the very moment the ask expires, and the late yes changes nothing', async () => {
    jest.useFakeTimers();
    let yes: (v: boolean) => void = () => {};
    const expires = Date.now() + HOST_PATIENCE;
    const said = answerBy(() => new Promise<boolean>((r) => (yes = r)), expires);
    jest.advanceTimersByTime(expires - Date.now());
    expect(await said).toBe(false);
    yes(true);
    expect(await said).toBe(false);
  });
});

describe('the question before a start', () => {
  it('names the class of computer and that it keeps running', () => {
    expect(startQuestion(ask()).say).toBe(
      'This starts another cloud computer on your plan. It keeps running until you stop it.',
    );
    expect(startQuestion(ask({ kind: 'desktop' })).title).toContain('with a desktop');
    expect(startQuestion(ask({ kind: 'browser' })).title).toContain('with a browser');
  });

  it('puts the safe answer in the safe slot', () => {
    expect(startQuestion(ask()).no).toBe('Cancel');
  });
});

describe('a temporary machine goes through the same question, every time', () => {
  it('is never covered by "Don\'t ask again", and it is not offered', () => {
    expect(silent(true, ask({ temporary: true }), 'me')).toBe(false);
    expect(mayRemember(ask({ temporary: true }), 'me')).toBe(false);
  });

  it('says in the question that its files are lost', () => {
    const q = startQuestion(ask({ temporary: true }));
    expect(q.title).toBe('Start a new temporary cloud computer?');
    expect(q.say).toContain('everything on it is lost when it stops');
  });
});

describe('with no word from the plan, every start asks', () => {
  it('skips the question only when the person said so AND the plan is known', () => {
    expect(silent(true, ask(), 'me')).toBe(true);
    expect(silent(true, ask({ limit: 2 }), 'me')).toBe(true);
    expect(silent(true, ask({ limit: null }), 'me')).toBe(false);
    expect(silent(false, ask(), 'me')).toBe(false);
    expect(mayRemember(ask({ limit: null }), 'me')).toBe(false);
  });
});

describe('a machine that would not be seen is always asked about, in those words', () => {
  it('never skips the question on a plan that streams no tabs, or one whose tabs are all open', () => {
    expect(silent(true, ask({ limit: 0, beyond: true }), 'me')).toBe(false);
    expect(silent(true, ask({ limit: 0 }), 'me')).toBe(false);
    expect(silent(true, ask({ limit: 2, beyond: true }), 'me')).toBe(false);
    expect(mayRemember(ask({ limit: 2, beyond: true }), 'me')).toBe(false);
  });

  it('says why it would not be seen', () => {
    expect(startQuestion(ask({ limit: 0, beyond: true })).say).toContain('Your plan does not stream tabs');
    expect(startQuestion(ask({ limit: 2, beyond: true })).say).toContain('streams 2 tabs at once and they are all open');
    expect(startQuestion(ask({ limit: 1, beyond: true })).say).toContain('streams 1 tab at once');
    expect(startQuestion(ask()).say).not.toContain('Your plan streams');
  });
});

describe('"Don\'t ask again" is per account and per class, says what it covers, and can be undone', () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };

  it('covers only the class it was said for', () => {
    const s = store();
    remember(s, 'ann', 'dev');
    expect(quietKinds(s, 'ann')).toEqual(['dev']);
  });

  it('covers only the account that said it', () => {
    const s = store();
    remember(s, 'ann', 'desktop');
    expect(quietKinds(s, 'bob')).toEqual([]);
  });

  it('is undone for every class at once', () => {
    const s = store();
    remember(s, 'ann', 'dev');
    remember(s, 'ann', 'browser');
    forget(s, 'ann');
    expect(quietKinds(s, 'ann')).toEqual([]);
  });

  it('keeps nothing, and offers nothing, without an account', () => {
    const s = store();
    remember(s, null, 'dev');
    expect(quietKinds(s, null)).toEqual([]);
    expect(mayRemember(ask(), null)).toBe(false);
    expect(startQuestion(ask(), null).remember).toBeUndefined();
  });

  it('reads storage that throws as remembering nothing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => remember(broken, 'ann', 'dev')).not.toThrow();
    expect(quietKinds(broken, 'ann')).toEqual([]);
    expect(() => forget(broken, 'ann')).not.toThrow();
  });

  it('says in the question which class and whose it covers', () => {
    expect(startQuestion(ask({ kind: 'desktop' }), 'ann').remember).toBe(
      "Don't ask again before starting a new cloud computer with a desktop, for this account in this browser",
    );
  });
});

describe('the question before a stop', () => {
  it('keeps it running in the safe slot', () => {
    expect(stopQuestion('cloud-1', { temporary: false, canStop: true }).no).toBe('Keep it running');
    expect(stopQuestion('cloud-1', { temporary: true, canStop: true }).no).toBe('Keep it running');
  });

  it('says a temporary machine loses its files, in the sentence and on the button', () => {
    const q = stopQuestion('cloud-m_2', { temporary: true, canStop: true });
    expect(q.say).toContain('stopping it deletes its files');
    expect(q.yes).toBe('Stop and lose its files');
  });

  it('says a machine with a disk keeps its files', () => {
    const q = stopQuestion('cloud-1', { temporary: false, canStop: true });
    expect(q.say).toContain('keeps its files');
    expect(q.yes).toBe('Stop it');
  });

  it('is a notice that it still runs, where nothing here can stop it', () => {
    const q = stopQuestion('cloud-1', { temporary: false, canStop: false });
    expect(q.no).toBeUndefined();
    expect(q.say).toContain('still running on your plan');
  });
});
