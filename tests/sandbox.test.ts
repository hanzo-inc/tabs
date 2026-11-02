import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { API, Refusal, createSandbox, frameUrl, grant, machineName, unfunded } from '@/lib/api';

/**
 * A sandbox joins the workspace as a machine whose URLs are MINTED, not
 * published — the one contract every Hanzo surface frames (a single-use
 * thirty-second ticket, and the page the mint names). These pin the properties
 * that would fail silently: the URL's only credential is the ticket, the address
 * asked for is the address opened, and a pane never mints twice for one bind.
 */
describe('the framed URL', () => {
  const mint = (url: string, ok = true) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = (async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      return { ok, status: ok ? 201 : 409, json: async () => ({ url }) };
    }) as unknown as typeof fetch;
    return calls;
  };

  it('asks the door it wants and frames the address that door answered', async () => {
    const calls = mint('/v1/sandboxes/box%201/terminal?ticket=tk%2B');
    const got = await frameUrl('bearer', 'box 1', 'terminal', 'build');
    expect(calls[0]!.url).toBe(`${API}/v1/sandboxes/box%201/terminal/ticket`);
    expect(calls[0]!.init!.method).toBe('POST');
    const u = new URL(got);
    expect(u.origin).toBe(new URL(API).origin);
    expect(u.pathname).toBe('/v1/sandboxes/box%201/terminal');
    expect(u.searchParams.get('ticket')).toBe('tk+');
    expect(u.searchParams.get('arg')).toBe('build');
    expect([...u.searchParams.keys()].sort()).toEqual(['arg', 'ticket']);
  });

  it('mints a SCREEN at the screen door, and gives it no shell name to attach to', async () => {
    // A machine has one display. An `arg` here would be a tmux session name sent
    // to something that has no tmux.
    const calls = mint('/v1/sandboxes/b/screen?ticket=tk');
    const got = await frameUrl('bearer', 'b', 'screen');
    expect(calls[0]!.url).toBe(`${API}/v1/sandboxes/b/screen/ticket`);
    expect(new URL(got).pathname).toBe('/v1/sandboxes/b/screen');
    expect([...new URL(got).searchParams.keys()]).toEqual(['ticket']);
  });

  it('never carries a bearer — the ticket IS the credential', async () => {
    mint('/v1/sandboxes/b/terminal?ticket=tk');
    const u = await frameUrl('a-real-looking-bearer-token', 'b', 'terminal', 's');
    expect(u).not.toMatch(/token|bearer|authorization/i);
  });

  it('refuses to frame anything when the mint refuses', async () => {
    mint('/v1/sandboxes/b/screen?ticket=tk', false);
    await expect(frameUrl('t', 'b', 'screen')).rejects.toThrow('screen ticket → 409');
  });
});

/**
 * A linked machine's tunnel, handed the identity this browser already holds.
 *
 * The tunnel is gated on hanzo.id, and hanzo.id refuses to be framed — so the
 * gate's own redirect could never run inside a pane, and the workspace used to
 * offer a second sign-in in a second tab for a session that already existed.
 * The grant is that redirect, skipped: one ask, with the token this page reads
 * the registry with, and the tunnel answers with the session.
 */
describe('the grant on a linked machine', () => {
  const answers = (res: Partial<Response>) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    global.fetch = (async (u: string, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      return { ok: false, status: 0, type: 'basic', ...res };
    }) as unknown as typeof fetch;
    return calls;
  };

  it('asks the tunnel itself, with the bearer, for a cookie it may keep', async () => {
    const calls = answers({ ok: true, status: 204 });
    await grant('bearer', 'https://g3q84fzbgfpy.share.hanzo.ai');
    expect(calls[0]!.url).toBe('https://g3q84fzbgfpy.share.hanzo.ai/.well-known/zrok/session');
    expect(calls[0]!.init!.method).toBe('POST');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer bearer');
    // Without this the browser discards the Set-Cookie and the pane, which
    // carries no bearer of its own, is refused on its very next request.
    expect(calls[0]!.init!.credentials).toBe('include');
  });

  it('never follows the sign-in it exists to avoid', async () => {
    // Chasing the 302 lands on hanzo.id — the page that cannot be framed and
    // must not be visited on a person's behalf.
    const calls = answers({ ok: true, status: 204 });
    await grant('t', 'https://x.share.hanzo.ai');
    expect(calls[0]!.init!.redirect).toBe('manual');
  });

  it('reports a tunnel that answers with a sign-in rather than a session', async () => {
    answers({ ok: false, type: 'opaqueredirect' as ResponseType });
    await expect(grant('t', 'https://x.share.hanzo.ai')).rejects.toThrow('asked for a sign-in');
  });

  it('reports a refusal as itself', async () => {
    answers({ ok: false, status: 403, type: 'basic' as ResponseType });
    await expect(grant('t', 'https://x.share.hanzo.ai')).rejects.toThrow('terminal grant → 403');
  });
});

describe('the workspace mints once per pane', () => {
  const src = readFileSync(join(process.cwd(), 'components/workspace.tsx'), 'utf8');

  it('stores the minted URL as pane state, never re-derives it per render', () => {
    // A ticket is spent by the frame's first load; deriving the URL on render
    // would hand the iframe a dead credential on the next paint.
    expect(src).toContain('minted[id] ?? null');
    expect(src).toContain('minting.current.has(id)');
  });

  it('has ONE source for a pane URL, whichever kind of machine serves it', () => {
    // The workspace used to fork: minted for a sandbox, derived from the
    // published tunnel for a linked machine — which is what left the linked
    // one framing a URL nobody had authorised, and a person staring at a
    // second sign-in. Both are minted now, so there is one path to be right.
    //
    // A page is the one pane with no machine and so no credential: its url IS
    // its binding. That is a different question, not a second answer to this
    // one — every pane that has a machine still reads the mint and nothing else.
    expect(src).toContain("b.kind === 'page' ? b.url : (minted[id] ?? null)");
    expect(src).not.toContain('shellUrl(');
    expect(src).not.toMatch(/host\?\.sandbox\s*\?/);
  });

  it('reconnect forgets the spent URL AND the readiness history', () => {
    expect(src).toContain('setMinted(drop)');
    expect(src).toContain('setAlive(drop)');
    expect(src).toContain('setWaited(drop)');
  });

  it('a refused pane offers a re-mint, and NEVER a second sign-in', () => {
    // The one rescue, for every pane. A dead credential cannot be reopened in a
    // tab, only asked for again — and sending someone to sign in a second time,
    // as the same person, on another domain, is the defect this replaced.
    expect(src).toMatch(/refused\[id\] \?[\s\S]*?Reconnect/);
    expect(src).not.toMatch(/Sign in to this terminal/);
    expect(src).not.toMatch(/target="_blank"/);
  });

  it('offers that rescue when the URL never arrived, not only when the frame died', () => {
    // A mint that fails leaves no iframe, so nothing is ever probed and the
    // readiness deadline never fires. Without this the pane says "waiting"
    // forever about a terminal nobody is going to bring.
    expect(src).toMatch(/\.catch\(\(\) => setWaited\(/);
  });
});

describe('a sandbox is named by its project', () => {
  it('goes by the project, which is what its disk is keyed on', () => {
    expect(machineName({ id: 'abcdef123456', status: 'running', project: 'cloud-1' })).toBe('cloud-1');
  });

  it('falls back to its id, so a projectless box is still openable', () => {
    expect(machineName({ id: 'abcdef123456', status: 'running' })).toBe('cloud-abcdef');
  });
});

/**
 * Starting one. The server keeps ONE live sandbox per project and refuses the
 * rest, so the name is picked against what is already live — which is the whole
 * difference between a second machine and a second attempt at the first.
 */
describe('a new cloud machine', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const answer = (live: unknown[], made: unknown, ok = true, status = ok ? 201 : 503) => {
    calls.length = 0;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = init?.method === 'POST' ? made : { sandboxes: live };
      return {
        ok: init?.method === 'POST' ? ok : true,
        status,
        json: async () => body,
      };
    }) as unknown as typeof fetch;
  };

  it('asks for a dev sandbox — the machine you shell into, not a scratch pod', async () => {
    answer([], { id: 'b1', status: 'running', project: 'cloud-1' });
    await createSandbox('t');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe(`${API}/v1/sandboxes`);
    expect(JSON.parse(String(post.init!.body))).toEqual({ class: 'dev', project: 'cloud-1' });
  });

  it('asks for a desktop under its OWN name — the project is what the disk is keyed on', async () => {
    // Borrowing the shell machines' project would be the same box's second
    // attempt (one live sandbox per project), not a second box.
    answer([{ id: 'b1', status: 'running', project: 'cloud-1' }], {
      id: 'b2',
      status: 'running',
      project: 'desk-1',
    });
    await createSandbox('t', 'desktop');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ class: 'desktop', project: 'desk-1' });
  });

  it('asks for a browser under its own name, a machine with a real page on its screen', async () => {
    answer([{ id: 'b1', status: 'running', project: 'desk-1' }], { id: 'b2', status: 'running', project: 'web-1' });
    await createSandbox('t', 'browser');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ class: 'browser', project: 'web-1' });
  });

  it('counts past the boxes already live, so pressing twice makes two', async () => {
    answer(
      [
        { id: 'b1', status: 'running', project: 'cloud-1' },
        { id: 'b2', status: 'running', project: 'cloud-2' },
      ],
      { id: 'b3', status: 'running', project: 'cloud-3' },
    );
    await createSandbox('t');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body)).project).toBe('cloud-3');
  });

  it("carries the server's reason, because a bare status code names none of them", async () => {
    answer([], { error: 'start sandbox: pod not running after 2m0s' }, false);
    await expect(createSandbox('t')).rejects.toThrow('pod not running after 2m0s');
  });

  // The refusal a person can actually act on, and the one the fleet spells
  // DIFFERENTLY from every other: money answers a NESTED {error:{code,message}}
  // where other endpoints answer a flat {error:"..."}. Reading only the flat shape
  // coerced that object into a string, so an org out of credit was told
  // "[object Object]" beside a button that had just failed.
  it('reads the money refusal, which is an object and not a sentence', async () => {
    answer(
      [],
      { error: { code: 'insufficient_balance', message: 'Add credit to start a machine' } },
      false,
      402,
    );
    const e = await createSandbox('t').catch((x) => x);
    expect(e).toBeInstanceOf(Refusal);
    expect(e.message).toBe('Add credit to start a machine');
    expect(e.message).not.toContain('object Object');
    expect(e.code).toBe('insufficient_balance');
    expect(e.status).toBe(402);
    // The whole point of carrying the CODE: the pane branches on it rather than
    // on the sentence, which is free to be reworded.
    expect(unfunded(e)).toBe(true);
  });

  it('a spend cap is answered the same way — put money on it, or bring a machine', async () => {
    answer([], { error: { code: 'spend_cap_exceeded', message: 'Monthly cap reached' } }, false, 402);
    expect(unfunded(await createSandbox('t').catch((x) => x))).toBe(true);
  });

  it('every other refusal is NOT a money one, so it offers no remedy it cannot keep', async () => {
    answer([], { error: 'start sandbox: pod not running after 2m0s' }, false, 503);
    const e = await createSandbox('t').catch((x) => x);
    expect(e.message).toContain('pod not running');
    expect(unfunded(e)).toBe(false);
  });

  it('never sends the bearer to anything but the API', async () => {
    answer([], { id: 'b1', status: 'running', project: 'cloud-1' });
    await createSandbox('t');
    for (const c of calls) expect(c.url.startsWith(API)).toBe(true);
  });
});
