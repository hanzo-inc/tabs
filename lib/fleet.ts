/**
 * The machines you have, ready to hand to a workspace.
 *
 * This is the wiring between a control plane and the `Workspace` component, and
 * it lived in the web app's page — which was fine while there was one host.
 * There are three now (tabs.hanzo.ai, the desktop shell, hanzo.ai), and the
 * wiring is the same React in each: read the registry, fold sessions and
 * sandboxes into machines, mint a url per pane, poll on the plane's own clock.
 * Copied three times it would be three sets of answers to how often a machine
 * goes stale.
 *
 * WHAT A HOST STILL OWNS is the token and where its cloud is. Everything else
 * is here. The token is passed in rather than fetched because each host gets it
 * its own way — a browser mints it with PKCE, the desktop already holds the
 * signed-in user's — and this module has no business knowing which.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  API,
  type Class,
  type Machine,
  type SandboxMachine,
  type Session,
  createSandbox,
  frameUrl,
  grant,
  machineName,
  machines,
  sandboxes,
  sessions,
} from './api';
import { type Binding, type TerminalHost, shellUrl } from './panes';
import { streams as readStreams } from './plan';

/** Machines heartbeat every 30s and the plane calls one stale after 90s, so
 *  polling faster than the fact changes would only cost requests. */
const BEAT = 30_000;

export interface Fleet {
  /** The machines, folded. Empty until the first read lands. */
  hosts: TerminalHost[];
  /** How many tabs the plan lets stream at once; null when the cloud does not
   *  say, which the workspace reads as no limit to enforce (`lib/plan.ts`). */
  streams: number | null;
  /** Whether a read has landed at all — which is a different fact from having
   *  no machines, and the one a caller needs to avoid claiming the second. */
  read: boolean;
  /** Why the registry could not be read, if it could not. */
  error: string | null;
  /** A fresh url for a pane. The workspace holds no token, so this does. */
  mint: (host: TerminalHost, what: Binding) => Promise<string>;
  /** Start a cloud box of one class and answer the name it goes by here. */
  launch: (kind: Class) => Promise<string>;
  /** Read the registry again now. */
  refresh: () => void;
}

/**
 * The bearer, or how to read it. A host whose session renews in storage (the
 * app's, platform's) passes the reader, so every poll and every mint asks it
 * afresh; a host that holds the token in state (tabs.hanzo.ai) passes the value.
 */
export type Token = string | null | (() => string | null);

export function useFleet(token: Token, origin: string = API): Fleet {
  const held = useRef(token);
  held.current = token;
  const bearer = useCallback((): string | null => {
    const t = held.current;
    return typeof t === 'function' ? t() : t;
  }, []);
  const [data, setData] = useState<{
    m: Machine[];
    s: Session[];
    b: SandboxMachine[];
    n: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async () => {
      const t = bearer();
      if (!t) return;
      try {
        // The registry is where machines and terminals come from. Sandboxes are
        // a SECOND read against the same plane: caught rather than reported,
        // because their absence costs those panes and nothing else, and a
        // banner about boxes you may not have is noise on a workspace that
        // still works.
        const [m, s, b, n] = await Promise.all([
          machines(t, origin),
          sessions(t, origin),
          sandboxes(t, origin).catch(() => []),
          // The plan's answer is not the registry's: a cloud that cannot give it
          // leaves the workspace unmetered rather than empty.
          readStreams(t, origin).catch(() => null),
        ]);
        setData({ m, s, b, n });
        setError(null);
      } catch (e) {
        // A registry that cannot be read is reported as such. Rendering an
        // empty workspace would claim "no machines", which is a different and
        // wrong thing.
        setError(e instanceof Error ? e.message : 'could not reach the registry');
      }
    },
    [origin, bearer],
  );

  const refresh = useCallback(() => void read(), [read]);

  // Read now, and on the plane's clock. A new token value reads at once; a
  // reader is asked on every beat, so a session renewed in storage is used
  // without the host re-rendering anything.
  useEffect(() => {
    void read();
    const beat = setInterval(() => void read(), BEAT);
    return () => clearInterval(beat);
  }, [token, read]);

  /**
   * Machines that can serve shells, and the tunnel each one's terminals live on.
   *
   * A terminal url is a fact about the MACHINE — one link, one ttyd, one tunnel
   * — so it is read from whichever of its sessions published one, rather than
   * treated as a property of that session. The workspace then names a shell per
   * pane with `?arg=`, so one link serves many.
   */
  const hosts = useMemo<TerminalHost[]>(() => {
    if (!data) return [];
    const base = new Map<string, string>();
    for (const s of data.s) {
      if (!s.terminal || !s.host) continue;
      if (s.status !== 'running' && s.status !== 'paused') continue;
      if (!base.has(s.host)) base.set(s.host, s.terminal);
    }
    const out = new Map<string, TerminalHost>();
    for (const m of data.m) {
      const key = m.host || m.label || m.id;
      out.set(key, { machine: key, base: base.get(key), status: m.status, label: m.capacity });
    }
    for (const [host, url] of base) {
      if (!out.has(host)) out.set(host, { machine: host, base: url, status: 'online' });
    }
    // A sandbox has no tunnel to publish — its terminal url is MINTED per open
    // (a single-use ticket), so the host carries the sandbox id instead of a
    // base and the workspace mints when a pane binds. One live sandbox per
    // project is the server's rule, so the project name is a stable, unique
    // machine name.
    for (const s of data.b) {
      const key = machineName(s);
      if (!out.has(key)) {
        out.set(key, {
          machine: key,
          sandbox: s.id,
          screen: s.class === 'desktop',
          status: 'online',
        });
      }
    }
    return [...out.values()];
  }, [data]);

  /**
   * A fresh url for a pane, minted where the token lives so the workspace stays
   * credential-free.
   *
   * ONE ACT, WHOEVER SERVES THE PAGE. A sandbox's terminal is hosted by cloud
   * and opened by a single-use ticket; a linked machine's is served by the
   * machine over its own tunnel, and what that tunnel wants is a session for
   * the identity already held here. Both are "ask with the token, then frame
   * the answer", which is why the workspace does not know which kind of machine
   * a pane is bound to.
   */
  const mint = useCallback(
    async (host: TerminalHost, what: Binding) => {
      const token = bearer();
      if (!token) throw new Error('signed out');
      if (host.sandbox) {
        return what.kind === 'screen'
          ? frameUrl(token, host.sandbox, 'screen', undefined, origin)
          : frameUrl(
              token,
              host.sandbox,
              'terminal',
              what.kind === 'shell' ? what.shell.name : undefined,
              origin,
            );
      }
      if (!host.base || what.kind !== 'shell') throw new Error('this machine serves no terminal');
      await grant(token, host.base);
      return shellUrl(host.base, what.shell.name);
    },
    [bearer, origin],
  );

  const launch = useCallback(
    async (kind: Class) => {
      const token = bearer();
      if (!token) throw new Error('signed out');
      const box = await createSandbox(token, kind, origin);
      await read();
      return machineName(box);
    },
    [bearer, origin, read],
  );

  return { hosts, streams: data?.n ?? null, read: data !== null, error, mint, launch, refresh };
}
