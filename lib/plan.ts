/**
 * What the plan allows: how many tabs may stream at once.
 *
 * The cloud decides it — Free streams none, Pro two, Max more — and this module
 * only asks. The answer is one integer, `tabs` on `GET /v1/entitlements`: 0 for
 * none, N for a cap, -1 for no cap. A plane that does not say (an older cloud, a
 * read that failed) answers `null`, and `null` is NOT a limit: the workspace
 * enforces only what it was told, so a cloud that has not shipped the key never
 * turns paying users away.
 *
 * A tab is STREAMED when a pane holds a live shell or screen. A page, or a
 * machine that is starting or gone, holds no stream and counts for nothing.
 */
import { API, READ_TIMEOUT } from './api';
import type { Binding } from './panes';

/** Where a person goes to change plan. */
export const UPGRADE = 'https://hanzo.ai/pricing';

export async function streams(token: string, origin = API): Promise<number | null> {
  const res = await fetch(`${origin}/v1/entitlements`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    // Read beside the registry, so a hang here would hold the same skeleton.
    signal: AbortSignal.timeout(READ_TIMEOUT),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { tabs?: unknown } | null;
  const n = body?.tabs;
  return typeof n === 'number' && Number.isInteger(n) && n >= -1 ? n : null;
}

const streamed = (b: Binding) => b.kind === 'shell' || b.kind === 'screen';

/**
 * The panes past the limit, in layout order: the first `limit` streamed panes
 * keep their stream and the rest wear the upgrade cover. Order, not age, so that
 * closing a pane hands its place to the next one along rather than to nobody.
 */
export function over(
  order: readonly string[],
  bind: Readonly<Record<string, Binding>>,
  limit: number | null,
): Set<string> {
  if (limit === null || limit < 0) return new Set();
  return new Set(order.filter((id) => bind[id] && streamed(bind[id]!)).slice(limit));
}

/**
 * Whether one more streamed tab would be past the limit: a new machine started
 * now would run, and bill, behind the plan's cover where nobody sees it. A plan
 * that streams none (0) is always full; one that has not said (`null`) or has
 * no cap (-1) never is.
 */
export function full(
  order: readonly string[],
  bind: Readonly<Record<string, Binding>>,
  limit: number | null,
): boolean {
  if (limit === null || limit < 0) return false;
  return order.filter((id) => bind[id] && streamed(bind[id]!)).length >= limit;
}
