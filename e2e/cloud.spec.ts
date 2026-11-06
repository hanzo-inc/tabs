import { test, expect, type Page } from '@playwright/test';

/**
 * Cloud machines, end to end: the three a workspace starts (a shell, a desktop,
 * a browser), started from the workspace's own buttons and from the host's menu
 * (@hanzo/app Sidebar, which asks by `hanzo:tabs-action`). The cloud is answered
 * here as api.hanzo.ai answers it — POST /v1/sandboxes leases one, a ticket mint
 * names the page to frame — so nothing reaches a real cloud.
 */
type Row = { id: string; status: string; project?: string; class: string };

const PAGE = (source: string, text: string) =>
  `<!doctype html><title>${text}</title><body style="background:#000;color:#0f0">${text}
<script>parent.postMessage({ source: '${source}' }, '*')</script>`;

async function cloud(page: Page, rows: Row[] = []) {
  const made: { class: string; project?: string }[] = [];
  const minted: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('hanzo_iam_access_token', 'stand-in-token');
    localStorage.setItem('hanzo_iam_expires_at', String(Date.now() + 3_600_000));
  });
  await page.route('https://api.hanzo.ai/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: cors });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST' } });
    if (path === '/v1/agents/targets') return json({ targets: [] });
    if (path === '/v1/agents/sessions') return json({ sessions: [], next: '' });
    if (path === '/v1/entitlements') return json({ tier: 'dev', apps: {}, tabs: -1 });
    if (path === '/v1/sandboxes' && req.method() === 'GET') {
      const want = url.searchParams.get('status');
      return json({ sandboxes: rows.filter((r) => !want || r.status === want) });
    }
    if (path === '/v1/sandboxes' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as { class: string; project?: string };
      made.push(body);
      const row = { id: `m_${made.length}`, status: 'running', ...body };
      rows.push(row);
      return json(row, 201);
    }
    const ticket = path.match(/^\/v1\/sandboxes\/([^/]+)\/(terminal|screen)\/ticket$/);
    if (ticket) {
      minted.push(`${ticket[2]}:${ticket[1]}`);
      return json({ url: `/v1/sandbox/${ticket[1]}/${ticket[2]}?ticket=tk` }, 201);
    }
    const door = path.match(/^\/v1\/sandbox\/([^/]+)\/(terminal|screen)$/);
    if (door) {
      return route.fulfill({
        contentType: 'text/html',
        body: door[2] === 'screen' ? PAGE('hanzo-screen', `SCREEN ${door[1]}`) : PAGE('hanzo-term', `TERMINAL ${door[1]}`),
      });
    }
    return route.fulfill({ status: 404, body: '{}', headers: cors });
  });
  return { made, minted };
}

const panes = (page: Page) => page.locator('iframe[data-pane]');

test.describe('cloud machines', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the flow, not the reach, is under test');
  });

  test('an empty workspace starts each of the three, and frames what each one shows', async ({ page }) => {
    const { made, minted } = await cloud(page);
    await page.goto('/app/');

    await page.getByRole('button', { name: 'New cloud machine' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();

    await page.getByRole('button', { name: 'New desktop' }).click();
    await expect(page.frameLocator('iframe[data-pane]').nth(1).getByText('SCREEN m_2')).toBeVisible();

    await page.getByRole('button', { name: 'New browser' }).click();
    await expect(page.frameLocator('iframe[data-pane]').nth(2).getByText('SCREEN m_3')).toBeVisible();

    expect(made).toEqual([
      { class: 'dev', project: 'cloud-1' },
      { class: 'desktop', project: 'desk-1' },
      { class: 'browser', project: 'web-1' },
    ]);
    expect(minted).toEqual(['terminal:m_1', 'screen:m_2', 'screen:m_3']);
    await expect(panes(page)).toHaveCount(3);
    await page.screenshot({ path: 'test-results/cloud-three.png' });
  });

  test('a brand-new workspace offers a browser before it has any machine', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New browser' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('SCREEN m_1')).toBeVisible();
    expect(made).toEqual([{ class: 'browser', project: 'web-1' }]);
  });

  test("the host's menu starts each of the three, and focuses a pane it names", async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/app/');
    await expect(page.getByRole('button', { name: 'New browser' })).toBeVisible();
    const ask = (detail: unknown) =>
      page.evaluate((d) => window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: d })), detail);
    const state = page.evaluate(
      () =>
        new Promise<string[]>((done) =>
          window.addEventListener('hanzo:tabs-state', (e) => {
            const bind = (e as CustomEvent<{ bind: Record<string, { kind: string }> }>).detail.bind;
            const kinds = Object.values(bind).map((b) => b.kind);
            if (kinds.filter((k) => k === 'screen').length === 2 && kinds.includes('shell')) done(kinds.sort());
          }),
        ),
    );

    await ask({ kind: 'shell' });
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    await ask({ kind: 'desktop' });
    await expect(page.frameLocator('iframe[data-pane]').nth(1).getByText('SCREEN m_2')).toBeVisible();
    await ask({ kind: 'page' });
    await expect(page.frameLocator('iframe[data-pane]').nth(2).getByText('SCREEN m_3')).toBeVisible();

    expect(made.map((m) => m.class)).toEqual(['dev', 'desktop', 'browser']);
    expect(await state).toEqual(['screen', 'screen', 'shell']);
  });

  test('a parked desktop keeps its name, so New desktop takes the next one', async ({ page }) => {
    const { made } = await cloud(page, [{ id: 'm_0', status: 'parked', project: 'desk-1', class: 'desktop' }]);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New desktop' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('SCREEN m_1')).toBeVisible();
    expect(made).toEqual([{ class: 'desktop', project: 'desk-2' }]);
  });
});
