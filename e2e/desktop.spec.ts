import { test, expect, type Page } from '@playwright/test';

import { cloud } from './standin';

/**
 * What a webview host (the desktop app) turns on, measured in a real browser:
 * a row of panes that scrolls instead of squeezing (`minPane`), the keys the
 * workspace claims (`shortcuts`), a terminal page that asks for a split or a
 * close, and the open panes announced for the host's own tab strip. The host is
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

  test('a terminal page can ask for a split or a close, with shortcuts on, and only for its own pane', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/?shortcuts=1');
    await open(page, 2);
    const second = page.frames().find((f) => f.url().includes('/m_2/terminal'))!;
    await second.evaluate(() => parent.postMessage({ source: 'hanzo-term', split: 'row' }, '*'));
    await expect(panes(page)).toHaveCount(3);
    expect(made).toHaveLength(3);
    await second.evaluate(() => parent.postMessage({ source: 'hanzo-term', close: true }, '*'));
    await expect(panes(page)).toHaveCount(2);
    // The page itself is not a frame of the workspace: its word is no command.
    await page.evaluate(() => postMessage({ source: 'hanzo-term', close: true }, '*'));
    await expect(panes(page)).toHaveCount(2);
  });

  test('without shortcuts a terminal page\'s split and close, and the host\'s, do nothing', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/');
    await open(page, 2);
    const second = page.frames().find((f) => f.url().includes('/m_2/terminal'))!;
    await second.evaluate(() => parent.postMessage({ source: 'hanzo-term', split: 'row' }, '*'));
    await second.evaluate(() => parent.postMessage({ source: 'hanzo-term', close: true }, '*'));
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'split', dir: 'row' } }));
      window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'close' } }));
    });
    await page.waitForTimeout(500);
    await expect(panes(page)).toHaveCount(2);
    expect(made).toHaveLength(2);
  });

  test('dragging a divider on a scrolled row does not drag the view back to the focused pane', async ({ page }) => {
    await cloud(page);
    await page.goto('/e2e/?minPane=420');
    await open(page, 4);
    await page.locator('[data-slot="pane-name"]').first().click();
    await page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>('*')].find((e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth)!;
      el.scrollTo({ left: el.scrollWidth });
    });
    const left = () =>
      page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].find((e) => getComputedStyle(e).overflowX === 'auto' && e.scrollWidth > e.clientWidth)!.scrollLeft);
    const before = await left();
    expect(before).toBeGreaterThan(100);
    const seam = (await page.getByRole('separator').last().boundingBox())!;
    await page.mouse.move(seam.x + seam.width / 2, seam.y + seam.height / 2);
    await page.mouse.down();
    await page.mouse.move(seam.x - 60, seam.y + seam.height / 2, { steps: 6 });
    await page.waitForTimeout(400);
    expect(Math.abs((await left()) - before)).toBeLessThan(5);
    await page.mouse.up();
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
