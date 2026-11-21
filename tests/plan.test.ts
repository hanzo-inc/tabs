import { full, over, streams } from '../lib/plan';
import type { Binding } from '../lib/panes';

const shell = (machine: string, name = 'shell-1'): Binding => ({ kind: 'shell', shell: { machine, name } });
const bind: Record<string, Binding> = {
  p0: shell('a'),
  p1: { kind: 'page', url: 'https://example.com' },
  p2: { kind: 'screen', machine: 'b' },
  p3: shell('a', 'shell-2'),
  p4: { kind: 'gone', shell: { machine: 'c', name: 'shell-1' } } as Binding,
};
const order = ['p0', 'p1', 'p2', 'p3', 'p4'];

describe('the panes past the plan', () => {
  it('keeps the first N streamed panes and covers the rest, in layout order', () => {
    expect([...over(order, bind, 2)]).toEqual(['p3']);
    expect([...over(order, bind, 1)]).toEqual(['p2', 'p3']);
  });

  it('counts only a live shell or screen: a page or a gone machine streams nothing', () => {
    expect([...over(['p1', 'p4'], bind, 0)]).toEqual([]);
  });

  it('streams nothing at 0, enforces nothing at -1 or when not told', () => {
    expect([...over(order, bind, 0)]).toEqual(['p0', 'p2', 'p3']);
    expect(over(order, bind, -1).size).toBe(0);
    expect(over(order, bind, null).size).toBe(0);
  });

  it('hands a closed pane\'s place to the next one along', () => {
    expect([...over(['p2', 'p3'], bind, 2)]).toEqual([]);
  });
});

describe('the plan as the cloud answers it', () => {
  const answer = (body: unknown, ok = true) => {
    global.fetch = jest.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;
  };

  it('reads the integer `tabs`', async () => {
    answer({ tier: 'dev', apps: {}, tabs: 2 });
    await expect(streams('t')).resolves.toBe(2);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.hanzo.ai/v1/entitlements',
      expect.objectContaining({ headers: { Authorization: 'Bearer t' } }),
    );
    answer({ tabs: 0 });
    await expect(streams('t')).resolves.toBe(0);
    answer({ tabs: -1 });
    await expect(streams('t')).resolves.toBe(-1);
  });

  it('says null, which is no limit, when the cloud does not say', async () => {
    answer({ tier: 'enterprise', apps: {} });
    await expect(streams('t')).resolves.toBeNull();
    answer({ tabs: '2' });
    await expect(streams('t')).resolves.toBeNull();
    answer({ tabs: 1.5 });
    await expect(streams('t')).resolves.toBeNull();
    answer({}, false);
    await expect(streams('t')).resolves.toBeNull();
  });
});


describe('whether one more tab would be past the limit', () => {
  const b: Record<string, Binding> = {
    a: shell('m1'),
    p: { kind: 'page', url: 'https://x' },
    s: { kind: 'screen', machine: 'd1' },
  };
  it('counts only what streams', () => {
    expect(full(['a', 'p', 's'], b, 2)).toBe(true);
    expect(full(['a', 'p', 's'], b, 3)).toBe(false);
  });
  it('is always full on a plan that streams none, and never without a cap', () => {
    expect(full([], {}, 0)).toBe(true);
    expect(full(['a', 's'], b, -1)).toBe(false);
    expect(full(['a', 's'], b, null)).toBe(false);
  });
});
