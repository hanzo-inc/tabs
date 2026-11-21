'use client';

/**
 * A HOST for the end-to-end suite, not a page of the product.
 *
 * It is built only when `TABS_E2E=1` (next.config.mjs adds the `.e2e.tsx`
 * page extension then and never otherwise), so the export that ships has no
 * such route. It mounts the real Workspace on the real `useFleet`, the way any
 * host does, and adds what only a host can give it: a `confirmLease` the test
 * answers, an account the test can change mid-session, and a menu of its own
 * outside the workspace that asks by `hanzo:tabs-action`, as @hanzo/app's does.
 *
 * `?confirm=host` passes the confirm. Each ask is pushed to
 * `window.__tabs.asks`, and the test answers it with `window.__tabs.answer(v)`:
 * a value resolves it, `'throw'` rejects it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Fill, Screen } from '@hanzo/ui';

import { Workspace } from '@/components/workspace';
import { useFleet } from '@/lib/fleet';
import type { StartAsk } from '@/lib/start';

type Probe = { asks: StartAsk[]; answer: (v: unknown) => void };

export default function Host() {
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [account, setAccount] = useState('e2e');
  useEffect(() => {
    setToken(window.localStorage.getItem('hanzo_iam_access_token'));
    setConfirm(new URLSearchParams(window.location.search).get('confirm') === 'host');
  }, []);
  const { hosts, streams, read, mint, launch, stop } = useFleet(token);

  const confirmLease = useMemo(() => {
    if (!confirm) return undefined;
    const probe: Probe = { asks: [], answer: () => {} };
    (window as unknown as { __tabs: Probe }).__tabs = probe;
    return (ask: StartAsk) =>
      new Promise<boolean>((yes, no) => {
        probe.asks.push(ask);
        probe.answer = (v) => (v === 'throw' ? no(new Error('the host confirm broke')) : yes(v as boolean));
      });
  }, [confirm]);

  return (
    <Screen render="main" height="100dvh" p="$1.5">
      <Button
        variant="ghost"
        size="sm"
        onPress={() => window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'cloud' } }))}
      >
        Start from the host menu
      </Button>
      <Fill scroll={false}>
        {read ? (
          <Workspace
            hosts={hosts}
            mint={mint}
            streams={streams}
            account={account}
            onLaunch={launch}
            onStop={stop}
            confirmLease={confirmLease}
            end={
              <Button variant="ghost" size="sm" onPress={() => setAccount((a) => (a === 'e2e' ? 'other' : 'e2e'))}>
                Switch account
              </Button>
            }
          />
        ) : null}
      </Fill>
    </Screen>
  );
}
