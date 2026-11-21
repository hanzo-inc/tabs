import { API, frameUrl, grant, signIn } from '@/lib/api';
import { type Binding, orphaned, within } from '@/lib/panes';

/**
 * Why a pane said "The terminal did not come up" — each cause found in the
 * code, pinned so it cannot come back. The owner met it on a machine he had
 * just started: the cover drew over a machine that was still booting, while
 * that machine kept running.
 */

describe('closing a pane leaves a cloud machine in no pane', () => {
  const b: Record<string, Binding> = {
    a: { kind: 'shell', shell: { machine: 'cloud-1', name: 'shell-1' } },
    b: { kind: 'shell', shell: { machine: 'cloud-1', name: 'shell-2' } },
    c: { kind: 'screen', machine: 'desk-1' },
    d: { kind: 'shell', shell: { machine: 'laptop', name: 'shell-1' } },
    p: { kind: 'page', url: 'https://x' },
  };
  const cloud = (m: string) => m !== 'laptop';
  it('names the machine only when its LAST pane closes', () => {
    expect(orphaned('a', b, cloud)).toBeNull();
    expect(orphaned('c', b, cloud)).toBe('desk-1');
  });
  it('never for a machine of your own, or a pane with no machine', () => {
    expect(orphaned('d', b, cloud)).toBeNull();
    expect(orphaned('p', b, cloud)).toBeNull();
    expect(orphaned('zz', b, cloud)).toBeNull();
  });
});

describe('2. a ready message is heard from the frame and from inside it, and nowhere else', () => {
  // Stand-ins for windows: what `within` reads is `parent`, which a
  // cross-origin window still exposes.
  const top: { parent?: unknown } = {};
  top.parent = top;
  const frame = { parent: top };
  const nested = { parent: frame };
  const deeper = { parent: nested };
  const other = { parent: top };

  it('hears the frame itself, as before', () => {
    expect(within(frame, frame, top)).toBe(true);
  });

  it('hears a page nested inside the frame', () => {
    expect(within(nested, frame, top)).toBe(true);
    expect(within(deeper, frame, top)).toBe(true);
  });

  it('never hears a sibling frame, the page itself, or no window at all', () => {
    expect(within(other, frame, top)).toBe(false);
    expect(within(top, frame, top)).toBe(false);
    expect(within(null, frame, top)).toBe(false);
    expect(within({}, frame, top)).toBe(false);
  });

  it('stops on a window that is its own parent, so a loop cannot hang it', () => {
    const lone: { parent?: unknown } = {};
    lone.parent = lone;
    expect(within(lone, frame, top)).toBe(false);
  });
});

describe("3. the terminal address is parsed, not glued, so a server address with no '?' still works", () => {
  const answer = (url: string) => {
    global.fetch = (async () => ({ ok: true, status: 201, json: async () => ({ url }) })) as unknown as typeof fetch;
  };

  it('adds the shell name as a query when the server named none', async () => {
    answer('/v1/sandboxes/b/terminal/tk123');
    const u = new URL(await frameUrl('t', 'b', 'terminal', 'shell-1'));
    expect(u.pathname).toBe('/v1/sandboxes/b/terminal/tk123');
    expect(u.searchParams.get('arg')).toBe('shell-1');
  });

  it('keeps the ticket and adds exactly one arg when the server named a query', async () => {
    answer('/v1/sandboxes/b/terminal?ticket=tk&arg=evil');
    const u = new URL(await frameUrl('t', 'b', 'terminal', 'shell-1'));
    expect(u.searchParams.get('ticket')).toBe('tk');
    expect(u.searchParams.getAll('arg')).toEqual(['shell-1']);
  });

  it('keeps a fragment out of the query', async () => {
    answer('/v1/sandboxes/b/terminal?ticket=tk#top');
    const u = new URL(await frameUrl('t', 'b', 'terminal', 'shell-1'));
    expect(u.searchParams.get('arg')).toBe('shell-1');
    expect(u.hash).toBe('#top');
  });

  it('frames on the host it asked, whatever the answer says', async () => {
    answer('/v1/sandboxes/b/screen?ticket=tk');
    expect(new URL(await frameUrl('t', 'b', 'screen')).origin).toBe(new URL(API).origin);
  });
});

describe('6. a linked machine whose tunnel wants a sign-in says so, with the button that does it', () => {
  const answers = (res: Partial<Response>) => {
    global.fetch = (async () => ({ ok: false, status: 0, type: 'basic', ...res })) as unknown as typeof fetch;
  };

  it('reports the tunnel\'s sign-in as its own kind of refusal', async () => {
    answers({ type: 'opaqueredirect' as ResponseType });
    const e = await grant('t', 'https://x.share.hanzo.ai').catch((x: unknown) => x);
    expect(signIn(e)).toBe(true);
  });

  it('keeps every other refusal apart from it', async () => {
    answers({ status: 403 });
    expect(signIn(await grant('t', 'https://x.share.hanzo.ai').catch((x: unknown) => x))).toBe(false);
    expect(signIn(new Error('terminal ticket → 409'))).toBe(false);
  });
});

