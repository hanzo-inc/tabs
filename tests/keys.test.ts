import { shortcut } from '@/lib/keys';
import { BRIDGE } from '@/lib/inline';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('the keys a workspace claims when its host owns the window', () => {
  it('splits right on ⌘D and down on ⌘⇧D', () => {
    expect(shortcut(key('d', { metaKey: true }))).toBe('split-row');
    expect(shortcut(key('D', { metaKey: true, shiftKey: true }))).toBe('split-col');
  });

  it('closes on ⌘W, but not ⌘⇧W (the host window\'s)', () => {
    expect(shortcut(key('w', { metaKey: true }))).toBe('close');
    expect(shortcut(key('W', { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('sizes type with ⌘= ⌘+ ⌘- and resets with ⌘0', () => {
    expect(shortcut(key('=', { metaKey: true }))).toBe('bigger');
    expect(shortcut(key('+', { metaKey: true, shiftKey: true }))).toBe('bigger');
    expect(shortcut(key('-', { metaKey: true }))).toBe('smaller');
    expect(shortcut(key('0', { metaKey: true }))).toBe('reset');
  });

  it('leaves Control to the terminal: Ctrl+D is end-of-input, Ctrl+W deletes a word', () => {
    expect(shortcut(key('d', { ctrlKey: true }))).toBeNull();
    expect(shortcut(key('w', { ctrlKey: true }))).toBeNull();
    expect(shortcut(key('d', { metaKey: true, ctrlKey: true }))).toBeNull();
  });

  it('ignores Alt chords, bare keys and other ⌘ keys', () => {
    expect(shortcut(key('d', { metaKey: true, altKey: true }))).toBeNull();
    expect(shortcut(key('d'))).toBeNull();
    expect(shortcut(key('c', { metaKey: true }))).toBeNull();
    expect(shortcut(key('', { metaKey: true }))).toBeNull();
  });
});

/** The bridge runs inside a terminal frame, where `shortcut` cannot be imported:
 *  run it against a fake window and hold it to the same table. */
describe('the key bridge inside a terminal frame', () => {
  const run = (e: ReturnType<typeof key>) => {
    let listener: ((e: unknown) => void) | undefined;
    const posted: unknown[] = [];
    const win = {
      addEventListener: (_t: string, l: (e: unknown) => void, capture: boolean) => {
        expect(capture).toBe(true);
        listener = l;
      },
      parent: { postMessage: (m: unknown, to: string) => (expect(to).toBe('*'), posted.push(m)) },
    };
    new Function('window', BRIDGE)(win);
    let stopped = false;
    listener!({ ...e, preventDefault: () => (stopped = true), stopPropagation: () => {} });
    return { posted, stopped };
  };

  it('posts a split or a close for the keys the workspace claims, and swallows them', () => {
    expect(run(key('d', { metaKey: true }))).toEqual({ posted: [{ source: 'hanzo-term', split: 'row' }], stopped: true });
    expect(run(key('d', { metaKey: true, shiftKey: true })).posted).toEqual([{ source: 'hanzo-term', split: 'col' }]);
    expect(run(key('w', { metaKey: true })).posted).toEqual([{ source: 'hanzo-term', close: true }]);
  });

  it('says nothing for the keys the terminal owns', () => {
    for (const e of [key('d', { ctrlKey: true }), key('w', { ctrlKey: true }), key('w', { metaKey: true, shiftKey: true }), key('c', { metaKey: true }), key('d')]) {
      expect(run(e)).toEqual({ posted: [], stopped: false });
    }
  });

  it('agrees with `shortcut` on which of those keys are split or close', () => {
    for (const e of [key('d', { metaKey: true }), key('d', { metaKey: true, shiftKey: true }), key('w', { metaKey: true }), key('w', { ctrlKey: true }), key('=', { metaKey: true })]) {
      const k = shortcut(e);
      const claimed = k === 'split-row' || k === 'split-col' || k === 'close';
      expect(run(e).posted.length > 0).toBe(claimed);
    }
  });
});
