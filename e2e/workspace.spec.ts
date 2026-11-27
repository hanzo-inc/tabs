import { test, expect, type Page } from '@playwright/test';

/**
 * The signed-in workspace, end to end, against the registry as api.hanzo.ai
 * answers it (GET /v1/agents/targets, GET /v1/agents/sessions, GET
 * /v1/entitlements) and a tunnel that grants a session and serves a terminal.
 * Nothing is sent to a real cloud: the browser holds a stand-in token and every
 * request to the cloud and to the tunnel is answered here.
 */
const TARGETS = {
  targets: [
    {
      id: 'tgt_box', label: 'box', kind: 'gpu', status: 'online', capacity: '10 vCPU / 122G / 1× GB10', host: 'box', terminal: 'https://box.share.hanzo.ai',
      spec: { os: 'linux', arch: 'aarch64', cpus: 10 }, metricsAt: '2026-10-12T15:29:40Z', sessions: 0, running: 0, updatedAt: '2026-10-12T15:29:40Z',
    },
  ],
};
const SESSIONS = {
  sessions: [
    {
      id: 'sess_shell', org: 'hanzo', agent: 'tmux', status: 'running', title: '/home/dev/app', host: 'box', cwd: '/home/dev/app',
      terminal: 'https://box.share.hanzo.ai', events: 2, startedAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-12T12:00:00Z',
    },
    {
      id: 'sess_code', org: 'hanzo', agent: 'claude', status: 'running', title: 'interactive coding session', host: 'box', cwd: '/home/dev/app',
      events: 14, startedAt: '2026-10-12T13:33:56Z', updatedAt: '2026-10-12T15:29:00Z',
    },
  ],
  next: '',
};
const TERMINAL = `<!doctype html><title>term</title><body style="background:#000;color:#0f0">TERMINAL READY
<script>parent.postMessage({ source: 'hanzo-term' }, '*')</script>`;

async function mount(page: Page, entitlements: Record<string, unknown>) {
  const grants: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('hanzo_iam_access_token', 'stand-in-token');
    localStorage.setItem('hanzo_iam_expires_at', String(Date.now() + 3_600_000));
  });
  await page.route('https://api.hanzo.ai/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
    if (path === '/v1/agents/targets') return json(TARGETS);
    if (path === '/v1/agents/sessions') return json(SESSIONS);
    if (path === '/v1/entitlements') return json(entitlements);
    if (path === '/v1/sandboxes') return json({ sandboxes: [] });
    return route.fulfill({ status: 404, body: '{}', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('https://box.share.hanzo.ai/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': 'http://127.0.0.1:4321', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'POST' } });
    if (req.method() === 'POST') {
      grants.push(new URL(req.url()).pathname);
      return route.fulfill({ status: 200, body: '{}', headers: { 'access-control-allow-origin': 'http://127.0.0.1:4321', 'access-control-allow-credentials': 'true' } });
    }
    return route.fulfill({ contentType: 'text/html', body: TERMINAL });
  });
  return grants;
}

const panes = (page: Page) => page.locator('iframe[data-pane]');

test.describe('the signed-in workspace', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the layout, not the reach, is under test');
  });

  test('opens a linked machine\'s shell once the tunnel has granted a session', async ({ page }) => {
    const grants = await mount(page, { tier: 'dev', apps: {}, tabs: 2 });
    await page.goto('/app/');
    await expect(panes(page)).toHaveCount(1);
    await expect(panes(page).first()).toHaveAttribute('src', /^https:\/\/box\.share\.hanzo\.ai\/.*arg=shell-1/);
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL READY')).toBeVisible();
    expect(grants).toEqual(['/.well-known/zrok/session']);
    await page.screenshot({ path: 'test-results/workspace-linked.png' });
  });

  test('streams as many tabs as the plan allows, and offers the plans for the next', async ({ page }) => {
    await mount(page, { tier: 'dev', apps: {}, tabs: 1 });
    await page.goto('/app/');
    await expect(panes(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'New shell' }).click();
    await expect(page.getByText('Your plan streams 1 tab at once.')).toBeVisible();
    await expect(panes(page)).toHaveCount(1);
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'See plans' }).click();
    expect((await popup).url()).toBe('https://hanzo.ai/pricing');
    await page.screenshot({ path: 'test-results/workspace-capped.png' });
  });

  test('the front page sends a signed-in reader to the workspace', async ({ page }) => {
    await mount(page, { tier: 'dev', apps: {}, tabs: 2 });
    await page.goto('/');
    await expect(page).toHaveURL(/\/app\/$/);
  });

  test('a plan that streams none streams none', async ({ page }) => {
    await mount(page, { tier: 'free', apps: {}, tabs: 0 });
    await page.goto('/app/');
    await expect(page.getByText('Your plan does not stream tabs.')).toBeVisible();
    await expect(panes(page)).toHaveCount(0);
  });

  test('a cloud that does not say enforces nothing', async ({ page }) => {
    await mount(page, { tier: 'dev', apps: {} });
    await page.goto('/app/');
    await expect(panes(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'New shell' }).click();
    await expect(panes(page)).toHaveCount(2);
    await expect(page.getByText(/Your plan/)).toHaveCount(0);
  });
});
