import { useEffect, useRef, useState } from 'react';

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
 * Three things have to change on the way, none of them a style choice:
 * - its socket address is relative to the page that served it, and a blob has
 *   no such page, so it is pointed at the minted address;
 * - a webview's CSP nonce disables inline scripts, so each is made a blob
 *   script instead;
 * - keys pressed inside a frame never reach the parent, so (with `bridge`)
 *   the ones the workspace claims are posted up (`lib/keys`, `termCommand`).
 */

/** Whether `url` is one of the cloud's terminal pages, the one page this knows how to inline. */
export const isTerminalPage = (url: string): boolean => /\/v1\/sandbox(?:es)?\/[^/]+\/terminal\b/.test(url);

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
 * The page rewritten to run from a blob. `script` turns code into the address
 * of a script that runs it. Throws for a page whose socket it cannot find: a
 * terminal left pointing nowhere is a pane that stays silent, and a failure
 * said here is the same silence (lib/comeup) without the wait for a guess.
 */
export function inlineHtml(
  html: string,
  url: string,
  bridge: boolean,
  script: (code: string) => string,
): string {
  if (!SOCKET.test(html)) throw new Error('terminal page has no socket to point');
  const pointed = html.replace(SOCKET, `var socket = ${JSON.stringify(socketOf(url))};\n  var ws = new WebSocket(socket)`);
  const inline = pointed.replace(/<script>([\s\S]*?)<\/script>/gi, (_m, code: string) => `<script src="${script(code)}"></script>`);
  if (!bridge) return inline;
  const tag = `<script src="${script(BRIDGE)}"></script>`;
  return inline.includes('</body>') ? inline.replace('</body>', `${tag}</body>`) : `${inline}${tag}`;
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
  const held = useRef(new Map<string, string[]>());
  const asked = useRef(new Set<string>());
  const want = urls.filter((u): u is string => !!u && isTerminalPage(u));
  const key = want.join('\n');

  useEffect(() => {
    if (!on) return;
    const now = new Set(want);
    for (const [u, blobs] of held.current) {
      if (now.has(u)) continue;
      blobs.forEach((b) => URL.revokeObjectURL(b));
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
        const made: string[] = [];
        try {
          const res = await fetch(u, { credentials: 'include' });
          if (!res.ok) throw new Error(`terminal page ${res.status}`);
          const html = inlineHtml(await res.text(), u, bridge, (code) => {
            const b = blob(code, 'application/javascript');
            made.push(b);
            return b;
          });
          const doc = blob(html, 'text/html;charset=utf-8');
          made.push(doc);
          // Released before it landed: the pane moved on to another address.
          if (!asked.current.has(u)) throw new Error('no longer asked for');
          held.current.set(u, made);
          setDocs((d) => ({ ...d, [u]: doc }));
        } catch {
          made.forEach((b) => URL.revokeObjectURL(b));
        }
      })();
    }
    // `key` is `want`, as a value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on, bridge]);

  // Nothing outlives the workspace.
  useEffect(
    () => () => {
      for (const blobs of held.current.values()) blobs.forEach((b) => URL.revokeObjectURL(b));
      held.current.clear();
    },
    [],
  );

  return docs;
}
