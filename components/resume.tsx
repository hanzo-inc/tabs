'use client';

import { useEffect } from 'react';

import { session } from '../lib/iam';

/**
 * A reader who already holds a session has no use for the front page: they came
 * from a link to Tabs, and Tabs is the workspace. Sends them there, and draws
 * nothing — a stranger sees the page exactly as it was exported.
 */
export function Resume() {
  useEffect(() => {
    if (session().authenticated) window.location.replace('/app/');
  }, []);
  return null;
}
