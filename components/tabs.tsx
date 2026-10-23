'use client';

/**
 * Tabs, whole: the reader's machines read with their token and tiled.
 *
 * Every host draws this and nothing else — tabs.hanzo.ai, the app at
 * hanzo.ai/tabs, platform.hanzo.ai/tabs — so the three agree on when the
 * workspace may open (once the registry has answered, never on an empty list
 * that only means "not read yet"), on what a failed read says, and on the plan's
 * stream count. A host supplies the bearer, where its cloud is, and the ends of
 * the action row.
 */
import type { ReactNode } from 'react';
import { useI18n } from '@hanzo/i18n/react';
import { SizableText, YStack } from '@hanzo/ui';

import { AMBER } from '../lib/panes';
import { type Token, useFleet } from '../lib/fleet';
import { Workspace } from './workspace';

export function Tabs({
  token,
  origin,
  at,
  start,
  end,
}: {
  /** The bearer, or how to read it (`useFleet`). */
  token: Token;
  /** The cloud's origin; api.hanzo.ai when not given. */
  origin?: string;
  /** A machine to show, from the host's address. */
  at?: string | null;
  /** The ends of the action row: the host's name for the place, its way out. */
  start?: ReactNode;
  end?: ReactNode;
}) {
  const { t } = useI18n();
  const fleet = useFleet(token, origin);

  if (!fleet.read) {
    return (
      <YStack flex={1} minH={0} items="center" justify="center" px="$5" data-slot="tabs">
        <SizableText size="$2" text="center" color={fleet.error ? AMBER : 'var(--text-disabled)'} role={fleet.error ? 'alert' : undefined}>
          {fleet.error
            ? t('Your machines could not be read: {why}', { why: fleet.error })
            : t('Reading your machines…')}
        </SizableText>
      </YStack>
    );
  }

  return (
    <YStack flex={1} minH={0} minW={0} data-slot="tabs">
      <Workspace
        hosts={fleet.hosts}
        mint={fleet.mint}
        streams={fleet.streams}
        onLaunch={fleet.launch}
        at={at}
        start={start}
        end={
          <>
            {fleet.error ? (
              <SizableText size="$1" color={AMBER} numberOfLines={1} ellipsis role="alert">
                {fleet.error}
              </SizableText>
            ) : null}
            {end}
          </>
        }
      />
    </YStack>
  );
}
