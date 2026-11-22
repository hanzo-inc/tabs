import { useEffect, useRef, useState } from 'react';

import { API } from './api';

/**
 * A terminal page the workspace fetches itself and hands the frame as a
 * `blob:` document, for hosts whose window is not allowed to frame it.
 *
 * The cloud terminal page is served with a `frame-ancestors` list of the web
 * origins that embed it. A webview with its own origin (a desktop app's
 * `tauri://localhost`) is on no such list, so the browser refuses the frame —
 * but a fetch is governed by CORS, which allows it, and the page is one
 * self-contained document. So the host sets `inlineFrames` on the Workspace and
 * the page is read here and framed from a blob, which has no ancestors to
 * check.
 *
 * Two things have to change on the way, neither of them a style choice:
 * - its socket address is relative to the page that served it, and a blob has
 *   no such page, so it is pointed at the minted address;
 * - keys pressed inside a frame never reach the parent, so (with `bridge`)
 *   the ones the workspace claims are posted up (`lib/keys`, `termCommand`).
 *
 * THE FRAME IS NOT SAME-ORIGIN, AND CANNOT BE. A blob document inherits the
 * origin of the page that made it, and this one was fetched from the network, so
 * `allow-same-origin` would give it the host's storage and sign-in token
 * (`sandboxFor`). Its scripts therefore stay inline: an opaque origin cannot
 * load a `blob:` script (measured). So a host whose CSP forbids inline scripts,
 * as a webview's nonce policy does, cannot use `inlineFrames` until its CSP
 * admits them for the blob document; the pane then says what any silent
 * frame says, Reconnect.
 */

/**
 * Whether `url` is the cloud's own terminal page, the one page this knows how to
 * inline: on the cloud's origin AND at its path. The path alone would hand any
 * host a blob frame, and a fetch with the person's cookies, for the asking.
 */
export function isTerminalPage(url: string, origin: string = API): boolean {
  try {
    const u = new URL(url);
    return u.origin === new URL(origin).origin && /^\/v1\/sandbox(?:es)?\/[^/]+\/terminal\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * What a frame may do. A `blob:` document inherits the origin of the page that
 * made it, so `allow-same-origin` on one would give a page fetched from the
 * network the host's own origin, its storage and its sign-in token. An inlined
 * frame therefore runs in an opaque origin, with scripts and nothing else; a
 * frame served from its own address keeps its own origin, which ttyd needs.
 */
export const sandboxFor = (inlined: boolean): string =>
  inlined ? 'allow-scripts' : 'allow-scripts allow-same-origin allow-forms';

/** The socket the terminal page at `url` talks to: the same address, as ws(s), under /ws. */
export function socketOf(url: string): string {
  const u = new URL(url);
  return `${u.origin.replace(/^http/, 'ws')}${u.pathname.replace(/\/+$/, '')}/ws${u.search}`;
}

/** Posts the claimed keys to the parent: ⌘D and ⌘⇧D split, ⌘W closes. It runs where
 *  `shortcut` (lib/keys) cannot be imported, so a test holds the two to one table. */
export const BRIDGE = `(function(){window.addEventListener('keydown',function(e){if(!e.metaKey||e.ctrlKey||e.altKey||!e.key)return;var k=e.key.toLowerCase();if(k==='d'){e.preventDefault();e.stopPropagation();window.parent.postMessage({source:'hanzo-term',split:e.shiftKey?'col':'row'},'*');}else if(k==='w'&&!e.shiftKey){e.preventDefault();e.stopPropagation();window.parent.postMessage({source:'hanzo-term',close:true},'*');}},true);})();`;

const SOCKET = /var\s+socket\s*=\s*[\s\S]*?var\s+ws\s*=\s*new\s+WebSocket\(socket\)/;

/**
 * The page rewritten to run from a blob. Throws for a page whose socket it
 * cannot find: a terminal left pointing nowhere is a pane that stays silent,
 * and a failure said here is the same silence (lib/comeup) without the wait
 * for a guess.
 */
export function inlineHtml(html: string, url: string, bridge: boolean): string {
  if (!SOCKET.test(html)) throw new Error('terminal page has no socket to point');
  const pointed = html.replace(SOCKET, `var socket = ${JSON.stringify(socketOf(url))};\n  var ws = new WebSocket(socket)`);
  if (!bridge) return pointed;
  const tag = `<script>${BRIDGE}</script>`;
  return pointed.includes('</body>') ? pointed.replace('</body>', `${tag}</body>`) : `${pointed}${tag}`;
}

const blob = (body: string, type: string) => URL.createObjectURL(new Blob([body], { type }));

/**
 * The frame addresses for `urls`: each terminal page fetched once, as it is
 * minted, and answered as a blob address in `docs`. A url with no entry is not
 * ready (or could not be made ready, and its pane says so by silence). Blobs
 * are released when their url is no longer asked for.
 */
export function useInline(urls: readonly (string | null)[], on: boolean, bridge: boolean): Record<string, string> {
  const [docs, setDocs] = useState<Record<string, string>>({});
  const held = useRef(new Map<string, string>());
  const asked = useRef(new Set<string>());
  const want = urls.filter((u): u is string => !!u && isTerminalPage(u));
  const key = want.join('\n');

  useEffect(() => {
    if (!on) return;
    const now = new Set(want);
    for (const [u, doc] of held.current) {
      if (now.has(u)) continue;
      URL.revokeObjectURL(doc);
      held.current.delete(u);
      asked.current.delete(u);
      setDocs((d) => {
        const { [u]: _gone, ...rest } = d;
        return rest;
      });
    }
    for (const u of want) {
      if (asked.current.has(u)) continue;
      asked.current.add(u);
      void (async () => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          if (!res.ok) throw new Error(`terminal page ${res.status}`);
          const doc = blob(inlineHtml(await res.text(), u, bridge), 'text/html;charset=utf-8');
          // Released before it landed: the pane moved on to another address.
          if (!asked.current.has(u)) return URL.revokeObjectURL(doc);
          held.current.set(u, doc);
          setDocs((d) => ({ ...d, [u]: doc }));
        } catch {
          /* silent: the come-up machine ends a frame that never speaks in its rescue */
        }
      })();
    }
    // `key` is `want`, as a value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on, bridge]);

  // Nothing outlives the workspace.
  useEffect(
    () => () => {
      for (const doc of held.current.values()) URL.revokeObjectURL(doc);
      held.current.clear();
    },
    [],
  );

  return docs;
}
