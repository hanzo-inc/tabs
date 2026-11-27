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
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  API,
  type AgentFrame,
  type AgentTurn,
  type Class,
  type Machine,
  type SandboxMachine,
  type Session,
  agentTurn,
  createSandbox,
  frameUrl,
  grant,
  machineName,
  machines,
  pause,
  sandboxes,
  sessions,
  subject,
} from './api';
import { type Binding, type TerminalHost, shellUrl } from './panes';
import { streams as readStreams } from './plan';
import { WAITING_EVENT } from './comeup';

/** Machines heartbeat every 30s and the plane calls one stale after 90s, so
 *  polling faster than the fact changes would only cost requests. */
export const BEAT = 30_000;

/** How often to read the list while a pane waits for its machine. The pane
 *  waits for the list to say it runs (lib/comeup), so a 30-second read would
 *  spend a third of its 90-second allowance just not looking. It is a list
 *  read only: nothing is minted for a pending machine. */
export const QUICK = 5_000;

/** How long until the next read of the list: quick only while a pane on
 *  screen is waiting for its machine and the page can be seen. A pending
 *  machine nobody is looking at, or a tab in the background, is read on the
 *  beat, so a machine stuck pending is not polled at speed for ever. */
export const every = (paneWaiting: boolean, visible: boolean): number =>
  paneWaiting && visible ? QUICK : BEAT;

/**
 * Machines that can serve shells, and the tunnel each one's terminals live on.
 *
 * A terminal url is a fact about the MACHINE — one link, one ttyd, one tunnel
 * — so it is the machine's own `terminal`. The workspace then names a shell per
 * pane with `?arg=`, so one link serves many.
 */
export function terminalHosts(
  machines: Machine[],
  sessions: Session[],
  sandboxes: SandboxMachine[],
): TerminalHost[] {
  // Bridge for CLIs that predate the machine's `terminal`: they published it on
  // their session only, which cloud stops after an hour idle. Drop with them.
  const bridge = new Map<string, string>();
  for (const s of sessions) {
    if (!s.terminal || !s.host) continue;
    if (s.status !== 'running' && s.status !== 'paused') continue;
    if (!bridge.has(s.host)) bridge.set(s.host, s.terminal);
  }
  const out = new Map<string, TerminalHost>();
  for (const m of machines) {
    const key = m.host || m.label || m.id;
    out.set(key, { machine: key, base: m.terminal || bridge.get(key), status: m.status, label: m.capacity });
  }
  for (const [host, url] of bridge) {
    if (!out.has(host)) out.set(host, { machine: host, base: url, status: 'online' });
  }
  // A sandbox has no tunnel to publish — its terminal url is MINTED per open
  // (a single-use ticket), so the host carries the sandbox id instead of a
  // base and the workspace mints when a pane binds. One live sandbox per
  // project is the server's rule, so the project name is a stable, unique
  // machine name.
  for (const s of sandboxes) {
    const key = machineName(s);
    if (!out.has(key)) {
      out.set(key, {
        machine: key,
        sandbox: s.id,
        screen: s.class === 'desktop' || s.class === 'browser',
        status: s.status === 'pending' ? 'pending' : 'online',
        // No project, no disk that outlives it.
        temporary: !s.project,
      });
    }
  }
  return [...out.values()];
}

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
  /** Start a cloud box of one class and answer the name it goes by here.
   *  `temporary` keeps no files; only a person's explicit choice asks for it. */
  launch: (kind: Class, opts?: { temporary?: boolean }) => Promise<string>;
  /** Stop a cloud box that is running and re-read, so it leaves the workspace. */
  stop: (host: TerminalHost) => Promise<void>;
  /** Have the AI work a cloud box, a step at a time (cloud's sandbox agent). */
  agent: (
    host: TerminalHost,
    body: { message: string; history: AgentTurn[] },
    onFrame: (f: AgentFrame) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Read the registry again now. */
  refresh: () => void;
  /** Whose machines these are (the token's subject), for what the workspace
   *  remembers per person. */
  account: string | null;
}

export function useFleet(token: string | null, origin: string = API): Fleet {
  const [data, setData] = useState<{
    m: Machine[];
    s: Session[];
    b: SandboxMachine[];
    n: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (t: string) => {
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
    [origin],
  );

  const refresh = useCallback(() => {
    if (token) void read(token);
  }, [token, read]);

  useEffect(() => {
    if (!token) return;
    void read(token);
  }, [token, read]);

  // Quicker while a pane waits for its machine and the page is seen.
  const [paneWaiting, setPaneWaiting] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onWaiting = (e: Event) => setPaneWaiting(!!(e as CustomEvent<{ waiting?: boolean }>).detail?.waiting);
    const onVisible = () => setVisible(document.visibilityState !== 'hidden');
    onVisible();
    window.addEventListener(WAITING_EVENT, onWaiting);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(WAITING_EVENT, onWaiting);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const wait = every(paneWaiting, visible);
  useEffect(() => {
    if (!token) return;
    const beat = setInterval(() => void read(token), wait);
    return () => clearInterval(beat);
  }, [token, read, wait]);

  const hosts = useMemo<TerminalHost[]>(
    () => (data ? terminalHosts(data.m, data.s, data.b) : []),
    [data],
  );

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
    [token, origin],
  );

  const launch = useCallback(
    async (kind: Class, opts?: { temporary?: boolean }) => {
      if (!token) throw new Error('signed out');
      const box = await createSandbox(token, kind, origin, opts?.temporary);
      await read(token);
      return machineName(box);
    },
    [token, origin, read],
  );

  const stop = useCallback(
    async (host: TerminalHost) => {
      if (!token) throw new Error('signed out');
      if (!host.sandbox) throw new Error('only a cloud computer can be stopped here');
      await pause(token, host.sandbox, origin);
      await read(token);
    },
    [token, origin, read],
  );

  const agent = useCallback(
    async (
      host: TerminalHost,
      body: { message: string; history: AgentTurn[] },
      onFrame: (f: AgentFrame) => void,
      signal: AbortSignal,
    ) => {
      if (!token) throw new Error('signed out');
      if (!host.sandbox) throw new Error('the AI works cloud computers; this one is linked');
      return agentTurn(token, host.sandbox, body, onFrame, signal, origin);
    },
    [token, origin],
  );

  const account = useMemo(() => subject(token), [token]);

  return { hosts, streams: data?.n ?? null, read: data !== null, error, mint, launch, stop, agent, refresh, account };
}
