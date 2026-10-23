'use client';

/**
 * The workspace.
 *
 * It reads the machine and session registries from api.hanzo.ai in the BROWSER,
 * with the caller's own token, and frames terminals the machines themselves
 * serve. No request passes through a server of ours, because there is no server
 * of ours — which is also why this page can be static.
 *
 * Sign-in is `@hanzo/iam` against hanzo.id — the same identity, and the same
 * client, as everything else Hanzo. The token lives in this browser because
 * there is nowhere else: inventing a session store would mean inventing the
 * server this product exists without.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Anchor, Button, Fill, H1, Paragraph, Screen, YStack } from '@hanzo/ui';

import { AMBER } from '@/lib/panes';
import { renew, session, signIn, signOut } from '@/lib/iam';
import { Tabs } from '@/components/tabs';

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A sign-in that did not go through. A failed registry read is the
   *  workspace's to say, a different failure with a different remedy. */
  const [refused, setRefused] = useState<string | null>(null);

  // The session this browser already holds, renewed if the access token has
  // aged out. Tabs is a window you leave open all day watching agents work, so
  // an hour-old token is the normal case on returning to the tab, not an edge
  // one — without the renew you would be signed out every time you came back.
  useEffect(() => {
    const s = session();
    if (s.authenticated) {
      setToken(s.accessToken);
      return;
    }
    void renew().then((r) => setToken(r.accessToken));
  }, []);

  // Renewed on its own clock, well inside the access token's hour, so a
  // workspace left open keeps reading the registry instead of quietly failing
  // every poll until someone notices the panes have gone stale. The registry's
  // own polling is the hook's.
  useEffect(() => {
    if (!token) return;
    const r = setInterval(() => void renew().then((v) => setToken(v.accessToken)), 10 * 60_000);
    return () => clearInterval(r);
  }, [token]);

  if (!token) {
    return (
      <YStack
        render="main"
        minH="100dvh"
        width="100%"
        maxW={448}
        mx="auto"
        justify="center"
        px="$5"
      >
        <H1 size="$6" fontWeight="600">
          Sign in
        </H1>
        <Paragraph mt="$2" size="$2" color="var(--muted-foreground)">
          Tabs reads your machines with your own Hanzo identity. It has no backend, so
          nothing about your session is stored anywhere but this browser.
        </Paragraph>
        <Button
          variant="primary"
          mt="$4.5"
          minH={44}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            signIn('/app').catch((e) => {
              setRefused(e instanceof Error ? e.message : 'sign-in failed');
              setBusy(false);
            });
          }}
        >
          {busy ? 'Taking you to hanzo.id…' : 'Continue with Hanzo'}
        </Button>
        {refused ? (
          <Paragraph mt="$3" size="$1" color={AMBER}>
            {refused}
          </Paragraph>
        ) : null}
        {/* The way back off a sign-in wall is the one link that must be easy to hit,
            so it reaches 44px like the button above it. Its text alone is 15 tall. */}
        <Anchor
          render={<Link href="/" />}
          size="$1"
          mt="$4"
          minH={44}
          display="inline-flex"
          items="center"
          color="var(--text-disabled)"
          hoverStyle={{ color: 'var(--muted-foreground)' }}
        >
          ← What is this?
        </Anchor>
      </YStack>
    );
  }

  return (
    <Screen render="main" height="100dvh" p="$1.5">
      <Fill scroll={false}>
        <Tabs
          token={token}
          // The brand and the way out ride in the workspace's action row.
          // They were a row of their own, which cost every pane ~28px of
          // terminal for two controls that fit in the gap beside the splits —
          // and a workspace is measured in rows you can read.
          start={
            <Anchor
              render={<Link href="/" />}
              size="$1"
              shrink={0}
              fontFamily="$mono"
              color="var(--text-secondary)"
              hoverStyle={{ color: '$color' }}
            >
              Tabs
            </Anchor>
          }
          end={
            <Button
              variant="ghost"
              size="sm"
              shrink={0}
              onPress={() => {
                void signOut();
                setToken(null);
              }}
            >
              Disconnect
            </Button>
          }
        />
      </Fill>

      {/* The assistant, bottom right — the SAME corner console.hanzo.ai and
          hanzo.app keep theirs in, so the three surfaces agree on where Hanzo
          lives. Tabs has no composer of its own (it is a terminal workspace,
          deliberately backendless), so this is the doorway, not the room. */}
      <Button
        render={<a href="https://hanzo.chat" target="_blank" rel="noreferrer noopener" />}
        size="icon"
        position="fixed"
        b="$4"
        r="$4"
        z={40}
        minW={44}
        minH={44}
        rounded={9999}
        bg="var(--card)"
        boxShadow="var(--shadow-lg)"
        hoverStyle={{ bg: 'var(--muted)' }}
        title="Ask Hanzo"
        aria-label="Ask Hanzo"
      >
        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </svg>
      </Button>
    </Screen>
  );
}
