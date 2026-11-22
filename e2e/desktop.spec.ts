import { test, expect, type Page } from '@playwright/test';

import { cloud } from './standin';

/**
 * What a webview host (the desktop app) turns on, measured in a real browser:
 * a row of panes that scrolls instead of squeezing (`minPane`), the keys the
 * workspace claims (`shortcuts`), the split and close a host asks for, and the open panes announced for the host's own tab strip. The host is
 * app/e2e/page.e2e.tsx; the cloud is e2e/standin.ts.
 */
const panes = (page: Page) => page.locator('iframe[data-pane]');

/** Open `n` cloud computers, one per press, each up before the next. */
async function open(page: Page, n: number) {
  for (let i = 1; i <= n; i++) {
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.frameLocator('iframe[data-pane]').nth(i - 1).getByText(`TERMINAL m_${i}`)).toBeVisible();
  }
}

const widths = async (page: Page) => Promise.all((await panes(page).all()).map(async (f) => (await f.boundingBox())!.width));

/** The box the panes scroll in, if any of them does. */
const scrolled = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('*')].find(
      (e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth,
    );
    return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
  });

test.describe('a webview host', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the layout, not the reach, is under test');
  });

  test('panes keep minPane and the row scrolls, where without it they squeeze', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/');
    await open(page, 4);
    expect(await scrolled(page)).toBeNull();
    for (const w of await widths(page)) expect(w).toBeLessThan(400); // four in 1440

    await page.goto('/e2e/?minPane=420');
    await expect(panes(page)).toHaveCount(4);
    for (const w of await widths(page)) expect(w).toBeGreaterThanOrEqual(419);
    const s = await scrolled(page);
    expect(s).not.toBeNull();
    expect(s!.scroll).toBeGreaterThan(s!.client);
    await page.screenshot({ path: 'test-results/desktop-minpane.png' });
  });

  test('with shortcuts, ⌘D splits, ⌘W closes the focused pane and ⌘= sizes the type', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/?shortcuts=1');
    await open(page, 2);

    await page.keyboard.press('Meta+d');
    await expect(panes(page)).toHaveCount(3);
    expect(made).toHaveLength(3);

    const size = page.getByTitle('Terminal text size');
    const was = Number(await size.textContent());
    await page.keyboard.press('Meta+=');
    await expect(size).toHaveText(String(was + 1));
    await page.keyboard.press('Meta+0');
    await expect(size).toHaveText('12');

    // Closing the last pane on a cloud computer asks about stopping it.
    await page.keyboard.press('Meta+w');
    await expect(panes(page)).toHaveCount(2);
    await expect(page.getByText(/^Stop .+\?$/)).toBeVisible();
  });

  test('without shortcuts those keys are the browser\'s, and nothing happens', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/');
    await open(page, 2);
    await page.keyboard.press('Meta+d');
    await page.keyboard.press('Meta+w');
    await page.keyboard.press('Meta+=');
    await expect(panes(page)).toHaveCount(2);
    expect(made).toHaveLength(2);
    await expect(page.getByTitle('Terminal text size')).toHaveText('12');
  });

  test('every part a host styles wears its slot, and the name bar says which pane has focus', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/');
    await open(page, 2);
    const slot = (n: string) => page.locator(`[data-slot="${n}"]`);
    for (const [name, count] of [
      ['tabs-root', 1], ['tabs-strip', 1], ['tabs-actions', 1], ['tabs-size', 1], ['tabs-scroll-container', 1],
      ['terminal-pane', 2], ['pane-name', 2], ['pane-close', 2],
      ['pane-split', 6], // the toolbar's two and each pane's two
    ] as const) await expect(slot(name)).toHaveCount(count);
    for (const dir of ['right', 'down']) await expect(page.locator(`[data-slot="pane-split"][data-dir="${dir}"]`)).toHaveCount(3);

    const focused = (n: number) => slot('pane-name').nth(n).getAttribute('data-focused');
    await slot('terminal-pane').nth(0).locator('[data-slot="pane-name"]').click();
    await expect.poll(() => focused(0)).toBe('true');
    expect(await focused(1)).toBe('false');
    await slot('terminal-pane').nth(1).locator('[data-slot="pane-name"]').click();
    await expect.poll(() => focused(1)).toBe('true');
    expect(await focused(0)).toBe('false');
  });

  test('with shortcuts, the host can ask for a split and a close by event', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/?shortcuts=1');
    await open(page, 2);
    const ask = (detail: object) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: d })), detail);
    await ask({ kind: 'split', dir: 'row' });
    await expect(panes(page)).toHaveCount(3);
    expect(made).toHaveLength(3);
    await ask({ kind: 'close' });
    await expect(panes(page)).toHaveCount(2);
  });

  test('without shortcuts the host\'s split and close do nothing', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/');
    await open(page, 2);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'split', dir: 'row' } }));
      window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'close' } }));
    });
    await page.waitForTimeout(500);
    await expect(panes(page)).toHaveCount(2);
    expect(made).toHaveLength(2);
  });

  test('a workspace that starts empty and then gets a machine still honours minPane', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/?minPane=420');
    await expect(page.getByText('No machine is serving terminals.')).toBeVisible();
    await open(page, 4); // the first from the empty state, the rest from the toolbar
    for (const w of await widths(page)) expect(w).toBeGreaterThanOrEqual(419);
    expect(await scrolled(page)).not.toBeNull();
  });

  test('dragging a divider on a scrolled row moves it, and does not drag the view back to the focused pane', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/?minPane=420');
    await open(page, 4);
    const scrollLeft = () =>
      page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].find((e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth)!.scrollLeft);
    // Focus the first pane, then scroll away from it to the end.
    await page.locator('[data-slot="pane-name"]').first().click();
    await page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>('*')].find((e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth)!;
      el.scrollTo({ left: el.scrollWidth });
    });
    await expect.poll(scrollLeft).toBeGreaterThan(100);
    const before = await scrollLeft();
    const w0 = await widths(page);
    const seam = (await page.getByRole('separator').last().boundingBox())!;
    const y = seam.y + seam.height / 2;
    await page.mouse.move(seam.x + seam.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(seam.x - 80, y, { steps: 8 });
    await page.waitForTimeout(600); // past the smooth scroll a re-focus would start
    const during = await scrollLeft();
    await page.mouse.up();
    await page.waitForTimeout(600);
    const w1 = await widths(page);
    // The divider moved: some pane's share of the row changed. (A pane under minPane makes the
    // canvas grow, so compare shares, not pixels.)
    const share = (w: number[], i: number) => w[i]! / w.reduce((x, y) => x + y, 0);
    expect(Math.max(...w0.map((_, i) => Math.abs(share(w1, i) - share(w0, i))))).toBeGreaterThan(0.02);
    // And the view did not jump, during the drag or after it.
    expect(Math.abs(during - before)).toBeLessThan(5);
    expect(Math.abs((await scrollLeft()) - before)).toBeLessThan(5);
  });

  test('the open panes are announced for the host\'s own tab strip', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/');
    await open(page, 2);
    const state = () =>
      page.evaluate(() => (window as unknown as { __hanzoTabsState: { items: { title: string; status: string; active: boolean }[]; focus: string } }).__hanzoTabsState);
    await expect.poll(async () => (await state()).items.length).toBe(2);
    const { items, focus } = await state();
    expect(items.every((i) => i.title.length > 0)).toBe(true);
    expect(items.filter((i) => i.active)).toHaveLength(1);
    expect(items.every((i) => i.status === 'online')).toBe(true);
    expect(focus).toBeTruthy();
  });
});
