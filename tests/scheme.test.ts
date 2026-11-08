import { FRAME, frameFilter, schemeOf } from '@/lib/scheme';

/**
 * A terminal follows the theme the page wears. The page marks its root with a
 * theme class (`t_light`, `t_dark`, `light`, `dark`) or a data-theme attribute;
 * with neither, the system decides.
 */
describe('the scheme a terminal wears', () => {
  test('reads the root’s theme class, in either spelling', () => {
    expect(schemeOf({ className: 't_light', theme: null }, true)).toBe('light');
    expect(schemeOf({ className: 'light', theme: null }, true)).toBe('light');
    expect(schemeOf({ className: 't_dark', theme: null }, false)).toBe('dark');
    expect(schemeOf({ className: 'a dark b', theme: null }, false)).toBe('dark');
  });

  test('reads data-theme when the class says nothing', () => {
    expect(schemeOf({ className: '', theme: 'light' }, true)).toBe('light');
    expect(schemeOf({ className: '', theme: 'dark' }, false)).toBe('dark');
  });

  test('falls back to the system, and a word that only contains a scheme is not one', () => {
    expect(schemeOf({ className: '', theme: null }, true)).toBe('dark');
    expect(schemeOf({ className: '', theme: null }, false)).toBe('light');
    expect(schemeOf({ className: 'twilight sunlight', theme: null }, true)).toBe('dark');
  });

  test('dark leaves the machine’s palette as it is; light turns it over on a white ground', () => {
    expect(FRAME.dark.ground).toBe('black');
    expect(frameFilter('dark', true)).toBeUndefined();
    expect(FRAME.light.ground).toBe('white');
    expect(frameFilter('light', true)).toBe('invert(1) hue-rotate(180deg)');
  });

  test('an unfocused pane is dimmed in either scheme, after the palette is turned', () => {
    expect(frameFilter('dark', false)).toBe('brightness(0.65)');
    expect(frameFilter('light', false)).toBe('invert(1) hue-rotate(180deg) brightness(0.94)');
  });
});
