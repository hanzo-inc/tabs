import { test, expect, type Page } from '@playwright/test';

/**
 * Where a new pane goes, measured in a real browser: New adds a column and
 * evens every column; a pane's own split divides that pane and nothing else,
 * and starts a new machine without asking where. The cloud is answered here as
 * api.hanzo.ai answers it (cloud.spec.ts has the same stand-in), so nothing
 * reaches a real one.
 */
type Row = { id: string; status: string; project?: string; class: string };

const PAGE = (source: string, text: string) =>
  `<!doctype html><title>${text}</title><body style="background:#000;color:#0f0">${text}
<script>parent.postMessage({ source: '${source}' }, '*')</script>`;

const SHOTS = process.env.SHOTS ?? 'test-results';

async function cloud(page: Page, rows: Row[] = []) {
  const made: string[] = [];
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
      // A lease takes a moment, so the pane's own wait is on screen to see.
      await new Promise((r) => setTimeout(r, 700));
      const body = JSON.parse(req.postData() ?? '{}') as { class: string; project?: string };
      made.push(body.class);
      const row = { id: `m_${made.length}`, status: 'running', ...body };
      rows.push(row);
      return json(row, 201);
    }
    const ticket = path.match(/^\/v1\/sandboxes\/([^/]+)\/(terminal|screen)\/ticket$/);
    if (ticket) return json({ url: `/v1/sandbox/${ticket[1]}/${ticket[2]}?ticket=tk` }, 201);
    const door = path.match(/^\/v1\/sandbox\/([^/]+)\/(terminal|screen)$/);
    if (door) return route.fulfill({ contentType: 'text/html', body: PAGE('hanzo-term', `TERMINAL ${door[1]}`) });
    return route.fulfill({ status: 404, body: '{}', headers: cors });
  });
  return made;
}

const panes = (page: Page) => page.locator('iframe[data-pane]');

/** Every pane's box, in DOM order (the order panes were opened). */
async function boxes(page: Page) {
  const all = await panes(page).all();
  return Promise.all(all.map(async (f) => (await f.boundingBox())!));
}

/** Within two pixels: a percentage of a box rounds, a layout does not drift. */
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(2);

test.describe('where a new pane goes', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the layout, not the reach, is under test');
  });

  test('New evens the columns; a split divides only its own pane, on a new machine, unasked', async ({ page }) => {
    const made = await cloud(page);
    await page.goto('/app/');

    // 1 → 2 → 3 from the top bar, each time every column equal.
    for (let n = 1; n <= 3; n++) {
      await page.getByRole('button', { name: 'New cloud machine' }).click();
      await expect(page.frameLocator('iframe[data-pane]').nth(n - 1).getByText(`TERMINAL m_${n}`)).toBeVisible();
      await expect(panes(page)).toHaveCount(n);
      const b = await boxes(page);
      for (const one of b) near(one.width, b[0]!.width);
      await page.screenshot({ path: `${SHOTS}/layout-${n}.png` });
    }
    const three = await boxes(page);
    const col = three[0]!.width;

    // The second pane's own Split right: that pane halves, the other two keep
    // their width, and nothing asks where the new shell should run.
    await page.getByRole('button', { name: 'Split right' }).nth(1).click();
    await expect(page.getByText('Where should this shell run?')).toHaveCount(0);
    await expect(page.getByText('Starting a machine. Its terminal opens here.')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/layout-split-starting.png` });
    await expect(page.frameLocator('iframe[data-pane]').nth(3).getByText('TERMINAL m_4')).toBeVisible();
    let b = await boxes(page);
    near(b[0]!.width, col);
    near(b[2]!.width, col);
    near(b[1]!.width, col / 2);
    near(b[3]!.width, col / 2);
    near(b[3]!.x, b[1]!.x + b[1]!.width);
    await page.screenshot({ path: `${SHOTS}/layout-split-right.png` });

    // The third pane's own Split down: that pane's column stacks two, every
    // other pane stays exactly where it was.
    const before = await boxes(page);
    await page.getByRole('button', { name: 'Split down' }).nth(2).click();
    await expect(page.getByText('Where should this shell run?')).toHaveCount(0);
    await expect(page.frameLocator('iframe[data-pane]').nth(4).getByText('TERMINAL m_5')).toBeVisible();
    b = await boxes(page);
    for (const i of [0, 1, 3]) {
      near(b[i]!.x, before[i]!.x);
      near(b[i]!.width, before[i]!.width);
      near(b[i]!.height, before[i]!.height);
    }
    near(b[2]!.width, before[2]!.width);
    near(b[4]!.x, b[2]!.x);
    near(b[4]!.width, b[2]!.width);
    near(b[4]!.height, b[2]!.height);
    expect(b[4]!.y).toBeGreaterThan(b[2]!.y + b[2]!.height);
    expect(b[2]!.height).toBeLessThan(before[2]!.height / 2 + 2);
    await page.screenshot({ path: `${SHOTS}/layout-split-down.png` });

    expect(made).toEqual(['dev', 'dev', 'dev', 'dev', 'dev']);
  });

  test('a seam drags under the pointer, and moves only the columns beside it', async ({ page }) => {
    await cloud(page);
    await page.goto('/app/');
    for (let n = 1; n <= 3; n++) {
      await page.getByRole('button', { name: 'New cloud machine' }).click();
      await expect(panes(page)).toHaveCount(n);
    }
    const b = await boxes(page);
    const seam = b[2]!.x;
    // The divider whose box straddles the second seam.
    let grab = null;
    for (const s of await page.getByRole('separator').all()) {
      const r = (await s.boundingBox())!;
      if (Math.abs(r.x + r.width / 2 - seam) < 4) grab = r;
    }
    expect(grab).not.toBeNull();
    const y = grab!.y + grab!.height / 2;
    await page.mouse.move(grab!.x + grab!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(seam + 120, y, { steps: 6 });
    await page.mouse.up();
    const after = await boxes(page);
    near(after[0]!.width, b[0]!.width);
    near(after[2]!.x, seam + 120);
  });

  test('the picker, where it is still shown, offers a new machine first', async ({ page }) => {
    const made = await cloud(page, [
      { id: 'm_a', status: 'running', project: 'cloud-1', class: 'dev' },
      { id: 'm_b', status: 'running', project: 'cloud-2', class: 'dev' },
    ]);
    await page.goto('/app/');
    await expect(panes(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'New shell' }).click();
    const picker = page.getByText('Where should this shell run?').locator('..');
    await expect(picker).toBeVisible();
    const rows = picker.getByRole('listitem');
    await expect(rows.first()).toHaveText('New machine');
    await expect(rows).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/layout-picker.png` });

    await rows.first().getByRole('button').click();
    // The stand-in numbers what it leases from one, so the first new one is m_1.
    await expect(page.frameLocator('iframe[data-pane]').nth(1).getByText('TERMINAL m_1')).toBeVisible();
    const b = await boxes(page);
    near(b[0]!.width, b[1]!.width);
    expect(made).toEqual(['dev']);
  });
});
