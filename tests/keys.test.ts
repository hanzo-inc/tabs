import { shortcut } from '@/lib/keys';

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
