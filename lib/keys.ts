/**
 * The keys a workspace claims when its host says it owns the window
 * (`shortcuts` on the Workspace): in a browser tab these belong to the browser —
 * bookmark, close tab, zoom — so a host turns them on only where there is no
 * browser around the workspace, as in a desktop webview.
 *
 * Command (⌘) only. Control is a terminal's own: Ctrl+D is end-of-input and
 * Ctrl+W deletes a word, and a workspace that took them would break the shell.
 */
export type Shortcut = 'split-row' | 'split-col' | 'close' | 'bigger' | 'smaller' | 'reset';

export function shortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): Shortcut | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || !e.key) return null;
  switch (e.key.toLowerCase()) {
    case 'd':
      return e.shiftKey ? 'split-col' : 'split-row';
    case 'w':
      return e.shiftKey ? null : 'close';
    case '=':
    case '+':
      return 'bigger';
    case '-':
      return 'smaller';
    case '0':
      return 'reset';
    default:
      return null;
  }
}
