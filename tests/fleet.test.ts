import { BEAT, QUICK, every, terminalHosts } from '@/lib/fleet';
import { waiting } from '@/lib/comeup';

describe('how often the list is read', () => {
  it('quickly only while a pane waits for its machine and the page is seen', () => {
    expect(every(true, true)).toBe(QUICK);
    expect(QUICK).toBeLessThanOrEqual(5_000);
  });
  it('on the beat in a background tab, or with no pane waiting, however many machines are pending', () => {
    expect(every(true, false)).toBe(BEAT);
    expect(every(false, true)).toBe(BEAT);
    expect(every(false, false)).toBe(BEAT);
  });
});

describe('whether a pane is waiting on the list', () => {
  it('is only a pane waiting for its machine', () => {
    expect(waiting({ a: { at: 'machine', tries: 0, deadline: 1, starting: true, listed: 'pending', epoch: 1 } })).toBe(true);
    expect(waiting({ a: { at: 'ready', url: 'u', epoch: 1 } })).toBe(false);
    expect(waiting({})).toBe(false);
  });
});

describe('where a machine\'s terminal is found', () => {
  const box = { id: 'tgt_box', label: 'box', host: 'box', status: 'online' };
  const session = (status: string) => ({ id: 's', host: 'box', status, terminal: 'https://old.share.hanzo.ai' });

  it('on the machine itself, even when its only session has been stopped', () => {
    const [h] = terminalHosts([{ ...box, terminal: 'https://box.share.hanzo.ai' }], [session('stopped')], []);
    expect(h.base).toBe('https://box.share.hanzo.ai');
  });
  it('on a running session of a machine that states none (a CLI older than the field)', () => {
    const [h] = terminalHosts([box], [session('running')], []);
    expect(h.base).toBe('https://old.share.hanzo.ai');
  });
  it('nowhere, when the machine states none and no session is live', () => {
    const [h] = terminalHosts([box], [session('stopped')], []);
    expect(h.base).toBeUndefined();
  });
});
