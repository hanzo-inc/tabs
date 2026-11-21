import { test, expect, type Page } from '@playwright/test';

import { cloud } from './standin';

/**
 * Cloud machines, end to end: the three a workspace starts (a shell, a desktop,
 * a browser), started from the workspace's own buttons and from the host's menu
 * (@hanzo/app Sidebar, which asks by `hanzo:tabs-action`). The cloud is answered
 * here as api.hanzo.ai answers it — POST /v1/sandboxes leases one, a ticket mint
 * names the page to frame — so nothing reaches a real cloud.
 */
const panes = (page: Page) => page.locator('iframe[data-pane]');

test.describe('cloud machines', () => {
  test.beforeEach(({ page: _ }, info) => {
    test.skip(info.project.name !== '1440', 'one width: the flow, not the reach, is under test');
  });

  test('an empty workspace starts each of the three, and frames what each one shows', async ({ page }) => {
    const { made, minted } = await cloud(page);
    await page.goto('/app/');

    await page.getByRole('button', { name: 'New cloud computer' }).click();
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
    // What a person reads says computer, start and stop, never the system's words.
    expect(await page.locator('body').innerText()).not.toMatch(/\b(sandbox|lease|ticket|credential|tmux)\b/i);
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

  test('a start asks first: Cancel starts nothing, Start it starts one', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText('This starts another cloud computer on your plan.');
    await q.getByRole('button', { name: 'Cancel' }).click();
    await expect(q).toHaveCount(0);
    expect(made).toEqual([]);
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start it' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    expect(made).toHaveLength(1);
  });

  test('the question opens on Cancel, keeps Tab inside it, and Escape starts nothing', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page);
    await page.goto('/app/');
    const button = page.getByRole('button', { name: 'New cloud computer' });
    await button.focus();
    await page.keyboard.press('Enter');
    const q = page.getByRole('alertdialog');
    await expect(q).toBeVisible();
    await expect(q.getByRole('button', { name: 'Cancel' })).toBeFocused();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await q.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(q).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(made).toEqual([]);
  });

  test('a double-click starts one machine, with the question and without it', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).dblclick();
    await expect(page.getByRole('alertdialog')).toHaveCount(1);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start it' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    expect(made).toHaveLength(1);
  });

  test('with Don\'t ask again, a double-click still starts one machine', async ({ page }) => {
    const { made } = await cloud(page);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).dblclick();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    await page.waitForTimeout(500);
    expect(made).toHaveLength(1);
  });

  test('out of credit offers a temporary machine, and starting it asks first, saying its files are lost', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page, [], { noCredit: true });
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start it' }).click();
    await expect(page.getByText('Your plan has no credit for a new cloud computer.')).toBeVisible();
    expect(made).toEqual([{ class: 'dev', project: 'cloud-1' }]);
    await page.getByRole('button', { name: 'Start a temporary one (files will not be kept)' }).click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText('everything on it is lost when it stops');
    await q.getByRole('button', { name: 'Cancel' }).click();
    expect(made).toHaveLength(1);
    await page.getByRole('button', { name: 'Start a temporary one (files will not be kept)' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start it' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_2')).toBeVisible();
    expect(made[1]).toEqual({ class: 'dev' });
  });

  test("Don't ask again covers one class on this account, and the toolbar undoes it", async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    const { made } = await cloud(page);
    await page.goto('/app/');
    const reset = page.getByRole('button', { name: 'Ask before starting again' });
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    let q = page.getByRole('alertdialog');
    await expect(q).toContainText("Don't ask again before starting a new cloud computer, for this account");
    await q.getByRole('checkbox').click();
    await q.getByRole('button', { name: 'Start it' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible();
    await expect(reset).toBeVisible();

    // Said for shells: the next shell does not ask…
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.frameLocator('iframe[data-pane]').nth(1).getByText('TERMINAL m_2')).toBeVisible();
    expect(made).toHaveLength(2);
    // …and a desktop still does.
    await page.getByRole('button', { name: 'New desktop' }).click();
    q = page.getByRole('alertdialog');
    await expect(q).toBeVisible();
    await q.getByRole('button', { name: 'Cancel' }).click();

    await reset.click();
    await expect(reset).toHaveCount(0);
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(made).toHaveLength(2);
  });

  test('closing the last pane on a temporary machine warns its files are lost, and keeps it by default', async ({ page }) => {
    const { stopped } = await cloud(page, [{ id: 'tmp1', status: 'running', class: 'dev' }]);
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL tmp1')).toBeVisible();
    const close = page.getByRole('button', { name: 'Close pane' }).first();
    await close.click();
    let q = page.getByRole('alertdialog');
    await expect(q).toContainText('stopping it deletes its files');
    await expect(q.getByRole('button', { name: 'Keep it running' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(q).toHaveCount(0);
    expect(stopped).toEqual([]);

    // The workspace opens a shell on it again; closed again, this time the
    // person chooses to lose them.
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL tmp1')).toBeVisible();
    await close.click();
    q = page.getByRole('alertdialog');
    await q.getByRole('button', { name: 'Stop and lose its files' }).click();
    await expect.poll(() => stopped).toEqual(['tmp1']);
  });

  test('a machine still pending is starting, not offline, and closing its pane asks whether to stop it', async ({ page }) => {
    const { made, stopped } = await cloud(page, [], { pending: true });
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect.poll(() => made.length).toBe(1);
    await expect(page.getByText('Starting your machine…')).toBeVisible();
    await expect(page.getByText('is offline')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close pane' }).first().click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText('cloud-1 is still running on your plan.');
    await q.getByRole('button', { name: 'Stop it' }).click();
    await expect.poll(() => stopped).toEqual(['m_1']);
  });

  test('a frame mounted again starts over: a fresh ticket, and no ready state left from the frame before', async ({ page }) => {
    const c = await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }]);
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();

    // The plan drops to no streams; the next start reads it, and the pane loses its frame.
    c.plan.tabs = 0;
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.locator('iframe[data-pane]')).toHaveCount(0);

    // The plan comes back and the pane's page now never says it is up: the
    // frame mounted again must ask for a fresh ticket and wait to hear afresh.
    c.plan.tabs = -1;
    c.door.silent = true;
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start it' }).click();
    await expect.poll(() => c.minted.filter((m) => m === 'terminal:m_0').length).toBe(2);
    await expect(page.getByText('The terminal did not come up.')).toBeVisible({ timeout: 15_000 });
  });

  test('a new machine whose ticket is refused every time ends failed after a bounded few tries, with Reconnect', async ({ page }) => {
    await page.clock.install();
    const { minted } = await cloud(page, [], { ticketFails: true });
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.getByText('Your machine is running. Opening its terminal…')).toBeVisible();
    // Past the 90-second allowance, in steps, each let reach the stand-in.
    test.setTimeout(120_000);
    for (let s = 0; s < 100; s += 10) {
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
    }
    await expect(page.getByText('The terminal did not come up.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(page.getByText(/Waiting for/)).toHaveCount(0);
    // One ask and three retries with backoff, then no more: never a loop.
    expect(minted).toEqual(Array(4).fill('terminal:m_1'));
  });

  test('a machine pending through its whole allowance is never asked for a ticket, ends failed, and opens once it runs', async ({ page }) => {
    await page.clock.install();
    const rows = [{ id: 'm_0', status: 'pending', project: 'cloud-1', class: 'dev' }];
    const { minted } = await cloud(page, rows);
    await page.goto('/app/');
    await expect(page.getByText('Starting your machine…')).toBeVisible();
    test.setTimeout(120_000);
    for (let s = 0; s < 100; s += 10) {
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
    }
    await expect(page.getByText('The terminal did not come up.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    expect(minted).toEqual([]);
    // It ran at last. A pane already given up on waits on nothing, so the list
    // is back on its beat; the next read moves the pane on by itself.
    rows[0]!.status = 'running';
    await page.clock.runFor(31_000);
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();
  });

  test('on a plan that streams no tabs, every start, the temporary one included, says it will not be seen', async ({ page }) => {
    const c = await cloud(page, [], { noCredit: true });
    c.plan.tabs = 0;
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    let q = page.getByRole('alertdialog');
    await expect(q).toContainText('Your plan does not stream tabs, so you will not see it');
    await q.getByRole('button', { name: 'Start it' }).click();
    await page.getByRole('button', { name: 'Start a temporary one (files will not be kept)' }).click();
    q = page.getByRole('alertdialog');
    await expect(q).toContainText('everything on it is lost when it stops');
    await expect(q).toContainText('Your plan does not stream tabs, so you will not see it');
  });

  test('a start past a full plan says how many tabs it streams and that it would run unseen', async ({ page }) => {
    const c = await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }]);
    c.plan.tabs = 1;
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText(
      'Your plan streams 1 tab at once and they are all open, so it would run where you cannot see it until a place frees up.',
    );
    // Not something "Don't ask again" may cover.
    await expect(q.getByRole('checkbox')).toHaveCount(0);
    await q.getByRole('button', { name: 'Cancel' }).click();
    expect(c.made).toEqual([]);
  });

  test('after a reload, a machine the list calls pending reads as starting, and opens once it runs', async ({ page }) => {
    // Only the list moves a pending pane on, and it is read every 5 seconds while one is pending.
    const rows = [{ id: 'm_0', status: 'pending', project: 'cloud-1', class: 'dev' }];
    const c = await cloud(page, rows);
    await page.goto('/app/');
    await expect(page.getByText('Starting your machine…')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Starting your machine…')).toBeVisible();
    await page.waitForTimeout(7_000); // past the deadline a silent frame would be failed at
    await expect(page.getByText('The terminal did not come up.')).toHaveCount(0);
    expect(c.minted).toEqual([]); // pending: nothing is asked of it
    rows[0]!.status = 'running';
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible({ timeout: 12_000 });
  });

  test('two questions in a row: focus stays in the second, then comes back to the workspace, not the page', async ({ page }) => {
    await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }], { slowStart: 2_000 });
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.getByText('Starting a machine. Its terminal opens here.')).toBeVisible();
    // Close the pane still starting (asked about when its machine arrives),
    // then the last pane on cloud-1 (asked about now).
    await page.getByRole('button', { name: 'Close pane' }).nth(1).click();
    await page.getByRole('button', { name: 'Close pane' }).first().click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText('Stop cloud-1?');
    await page.waitForTimeout(2_500); // cloud-2 arrives, and its question queues behind
    await page.keyboard.press('Escape');
    await expect(q).toContainText('Stop cloud-2?');
    await page.waitForTimeout(300);
    await expect(q.getByRole('button', { name: 'Keep it running' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(q).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('closing a pane while its machine starts asks about it when it arrives, and a stop that fails says so', async ({ page }) => {
    const c = await cloud(page, [], { slowStart: 1_500 });
    await page.route('https://api.hanzo.ai/v1/sandbox/*/pause', (route) =>
      route.fulfill({ status: 500, body: '{}', headers: { 'access-control-allow-origin': '*' } }),
    );
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await page.getByRole('button', { name: 'Close pane' }).click();
    const q = page.getByRole('alertdialog');
    await expect(q).toContainText('Stop cloud-1?');
    await expect(q).toContainText('cloud-1 is still running on your plan.');
    await q.getByRole('button', { name: 'Stop it' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Could not stop cloud-1');
    await expect(page.getByRole('alertdialog')).toContainText('It is still running.');
    expect(c.stopped).toEqual([]);
    // Focus is in the notice, not pulled back behind it to where the first question began.
    await page.waitForTimeout(300);
    expect(await page.getByRole('alertdialog').evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('a new machine whose ticket is refused at first reads as starting, and opens once a fresh one is granted', async ({ page }) => {
    const { minted } = await cloud(page, [], { ticketFailures: 2 });
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New cloud computer' }).click();
    await expect(page.getByText('Your machine is running. Opening its terminal…')).toBeVisible();
    await expect(page.getByText('The terminal did not come up.')).toHaveCount(0);
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_1')).toBeVisible({ timeout: 15_000 });
    expect(minted).toEqual(['terminal:m_1', 'terminal:m_1', 'terminal:m_1']);
  });

  test('a question opened with nothing focused hands focus to the workspace, never to the page body', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { askFirst?: boolean }).askFirst = true;
    });
    await cloud(page, [{ id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' }]);
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();
    // As Safari leaves it after a click, or as a question nobody pressed for finds it.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new CustomEvent('hanzo:tabs-action', { detail: { kind: 'cloud' } }));
    });
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('the list is read quickly only while a pane waits for its machine and the tab is seen', async ({ page }) => {
    await page.clock.install();
    const c = await cloud(page, [{ id: 'm_0', status: 'pending', project: 'cloud-1', class: 'dev' }]);
    await page.goto('/app/');
    await expect(page.getByText('Starting your machine…')).toBeVisible();
    const before = c.reads.n;
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(5_000);
      await page.waitForTimeout(100);
    }
    expect(c.reads.n - before).toBeGreaterThanOrEqual(3); // quick: every 5 s
    // The tab goes to the background: the pace drops to the beat.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(100);
    const hidden = c.reads.n;
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(5_000);
      await page.waitForTimeout(100);
    }
    expect(c.reads.n - hidden).toBeLessThanOrEqual(1); // the beat: once in 30 s
  });

  test('a pending machine with no pane waiting on it is read on the beat', async ({ page }) => {
    await page.clock.install();
    // A running machine holds the pane; the pending one has none.
    const c = await cloud(page, [
      { id: 'm_0', status: 'running', project: 'cloud-1', class: 'dev' },
      { id: 'm_9', status: 'pending', project: 'cloud-9', class: 'dev' },
    ]);
    await page.goto('/app/');
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('TERMINAL m_0')).toBeVisible();
    const before = c.reads.n;
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(5_000);
      await page.waitForTimeout(100);
    }
    expect(c.reads.n - before).toBeLessThanOrEqual(1);
  });

  test('a parked desktop keeps its name, so New desktop takes the next one', async ({ page }) => {
    const { made } = await cloud(page, [{ id: 'm_0', status: 'parked', project: 'desk-1', class: 'desktop' }]);
    await page.goto('/app/');
    await page.getByRole('button', { name: 'New desktop' }).click();
    await expect(page.frameLocator('iframe[data-pane]').first().getByText('SCREEN m_1')).toBeVisible();
    expect(made).toEqual([{ class: 'desktop', project: 'desk-2' }]);
  });
});
