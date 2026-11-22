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

  test('a terminal page can ask for a split or a close, and only for its own pane', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/e2e/');
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
