import { machines, READ_TIMEOUT } from '../lib/api';
import { streams } from '../lib/plan';

/**
 * A registry read that never answers held the workspace on its skeleton for
 * good. Every read now carries a deadline, so a hang becomes the error state
 * (and its retry) instead.
 */
describe('registry reads have a deadline', () => {
  const hang = (ctl: AbortController) => {
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(ctl.signal);
    global.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('timed out')));
      })) as unknown as typeof fetch;
  };
  afterEach(() => jest.restoreAllMocks());

  it('gives a read that never answers a signal, and fails when it fires', async () => {
    const ctl = new AbortController();
    hang(ctl);
    const read = machines('t');
    ctl.abort();
    await expect(read).rejects.toThrow('timed out');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(READ_TIMEOUT);
  });

  it('does the same for the plan read', async () => {
    const ctl = new AbortController();
    hang(ctl);
    const read = streams('t');
    ctl.abort();
    await expect(read).rejects.toThrow('timed out');
  });
});
