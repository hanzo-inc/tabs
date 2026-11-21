import { test, expect, type Page } from '@playwright/test';

import { cloud } from './standin';

/**
 * The Workspace under a host that asks for itself (`confirmLease`), and under
 * an account that changes while it is open. The host is app/e2e/page.e2e.tsx,
 * built only for this suite (TABS_E2E=1); everything below it is the shipped
 * Workspace and useFleet against the stand-in cloud.
 */
type Probe = { asks: unknown[]; answer: (v: unknown) => void };
const asks = (page: Page) => page.evaluate(() => (window as unknown as { __tabs: Probe }).__tabs.asks);
const answer = (page: Page, v: unknown) =>
  page.evaluate((x) => (window as unknown as { __tabs: Probe }).__tabs.answer(x), v);

test.describe('a host that asks for itself', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the contract, not the reach, is under test');
  });

  test('is asked once, with everything to say, and the workspace asks nothing of its own', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page);
    await page.goto('/e2e/?confirm=host');
    const start = page.getByRole('button', { name: 'New cloud computer' });
    await start.click();
    const [ask] = (await asks(page)) as { expires: number }[];
    await expect.poll(() => asks(page)).toEqual([
      { kind: 'dev', from: 'button', temporary: false, beyond: false, limit: -1, expires: ask!.expires },
    ]);
    // Two minutes from the ask, on the page's own clock.
    expect(ask!.expires - (await page.evaluate(() => Date.now()))).toBeGreaterThan(110_000);
    // While the host asks, the start is in flight: nothing else starts.
    await start.click({ force: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await asks(page)).toHaveLength(1);
    await answer(page, true);
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    expect(made).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Ask before starting again' })).toHaveCount(0);
  });

  for (const [said, value] of [
    ['false', false],
    ['a value that is not true', 'yes'],
    ['a throw', 'throw'],
  ] as const) {
    test(`starts nothing on ${said}`, async ({ page }) => {
      const { made } = await cloud(page);
      await page.goto('/e2e/?confirm=host');
      await page.getByRole('button', { name: 'New cloud computer' }).click();
      await expect.poll(async () => (await asks(page)).length).toBe(1);
      await answer(page, value);
      await expect(page.getByRole('button', { name: 'New cloud computer' })).toBeEnabled();
      await page.waitForTimeout(300);
      expect(made).toEqual([]);
      await expect(page.locator('iframe[data-pane]')).toHaveCount(0);
    });
  }

  test('starts nothing on a yes that comes after two minutes, and frees the workspace', async ({ page }) => {
    await page.clock.install();
    const { made } = await cloud(page);
    await page.goto('/e2e/?confirm=host');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect.poll(async () => (await asks(page)).length).toBe(1);
    await page.clock.fastForward(120_001);
    await expect(page.getByRole('button', { name: 'New cloud computer' })).toBeEnabled();
    await answer(page, true);
    await page.waitForTimeout(300);
    expect(made).toEqual([]);
  });
});

test.describe('the account changes mid-session', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width');
  });

  test("Don't ask again said by one account does not cover the next", async ({ page }) => {
    // Remembered for the account `e2e`; one machine running, so the toolbar shows.
    const { made } = await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }]);
    await page.goto('/e2e/');
    const reset = page.getByRole('button', { name: 'Ask before starting again' });
    await expect(reset).toBeVisible();
    await page.getByRole('button', { name: 'Switch account' }).click();
    await expect(reset).toHaveCount(0);
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(made).toEqual([]);
  });
});

test.describe("the host's own menu", () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width');
  });

  test('gets focus back when the question its press opened is answered', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }]);
    await page.goto('/e2e/');
    const menu = page.getByRole('button', { name: 'Start from the host menu' });
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(menu).toBeFocused();
  });
});
