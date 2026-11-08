import { useEffect, useState } from 'react';

/**
 * Whether the reader is in the light or the dark theme, and what the terminals
 * wear for it.
 *
 * A terminal is a page of its own in a frame (the machine serves it), painted
 * from one dark palette: true black, light text, pastel ANSI colours chosen to
 * hold their contrast on black. In the light theme the frame turns that palette
 * over — lightness flipped, every hue kept (`invert(1) hue-rotate(180deg)`) — so
 * the ground is white, the text dark, and each ANSI colour is the same colour
 * made dark enough for white. It is done on the frame, not by telling the page,
 * because the page is the machine's and an older machine would never hear a
 * palette it was sent: the frame changes with the theme at once, on every
 * terminal, with none reopened.
 */
export type Scheme = 'light' | 'dark';

/** The scheme a document's root wears (its theme class or attribute), else the system's. */
export function schemeOf(root: { className: string; theme: string | null }, systemDark: boolean): Scheme {
  const words = `${root.className} ${root.theme ?? ''}`.split(/[\s_-]+/);
  if (words.includes('light')) return 'light';
  if (words.includes('dark')) return 'dark';
  return systemDark ? 'dark' : 'light';
}

/** What a frame is painted with: its ground, the filter that turns the palette over, and how far an unfocused pane is dimmed. */
export const FRAME = {
  dark: { ground: 'black', turn: '', dim: 'brightness(0.65)' },
  light: { ground: 'white', turn: 'invert(1) hue-rotate(180deg)', dim: 'brightness(0.94)' },
} as const;

/** A frame's CSS filter: the palette turned for the scheme, then dimmed when its pane is not the focused one. */
export function frameFilter(scheme: Scheme, focused: boolean): string | undefined {
  const parts = [FRAME[scheme].turn, focused ? '' : FRAME[scheme].dim].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

/** The reader's scheme, followed live as the theme changes. Dark until the page is up, as it is on the server. */
export function useScheme(): Scheme {
  const [scheme, set] = useState<Scheme>('dark');
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const read = () => set(schemeOf({ className: root.className, theme: root.getAttribute('data-theme') }, media.matches));
    read();
    const watch = new MutationObserver(read);
    watch.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    media.addEventListener('change', read);
    return () => {
      watch.disconnect();
      media.removeEventListener('change', read);
    };
  }, []);
  return scheme;
}
