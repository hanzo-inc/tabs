import type { Page } from '@playwright/test';

/**
 * api.hanzo.ai as the specs need it, answered in the browser: the registry,
 * the plan, starting and stopping a sandbox, its ticket and the page the
 * ticket opens. Nothing reaches a real cloud. What a test may change mid-run
 * (`plan`, `door`, the `rows`) is read on every request.
 */
export type Row = { id: string; status: string; project?: string; class: string };

const PAGE = (source: string, text: string) =>
  `<!doctype html><title>${text}</title><body style="background:#000;color:#0f0">${text}
<script>parent.postMessage({ source: '${source}' }, '*')</script>`;

export async function cloud(
  page: Page,
  rows: Row[] = [],
  o: { noCredit?: boolean; pending?: boolean; ticketFails?: boolean; ticketFailures?: number; slowStart?: number; inline?: boolean } = {},
) {
  let failures = o.ticketFailures ?? 0;
  const made: { class: string; project?: string }[] = [];
  const minted: string[] = [];
  const stopped: string[] = [];
  /** How many times the sandbox list was read. */
  const reads = { n: 0 };
  // Read on every request, so a test can change the plan or the page mid-run.
  const plan = { tabs: -1 };
  const doorPage = { silent: false };
  await page.addInitScript(() => {
    // JWT-shaped, so the workspace knows whose "Don't ask again" to read.
    localStorage.setItem('hanzo_iam_access_token', `h.${btoa(JSON.stringify({ sub: 'e2e' }))}.s`);
    localStorage.setItem('hanzo_iam_expires_at', String(Date.now() + 3_600_000));
    // These specs are about what a start opens, not the question before it;
    // "Don't ask again" was answered. The question has its own test.
    if (!(window as { askFirst?: boolean }).askFirst) {
      for (const k of ['dev', 'desktop', 'browser']) localStorage.setItem(`hanzo.tabs.start.quiet.v2:e2e:${k}`, '1');
    }
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
    if (path === '/v1/entitlements') return json({ tier: 'dev', apps: {}, tabs: plan.tabs });
    if (path === '/v1/sandboxes' && req.method() === 'GET') {
      reads.n++;
      const want = url.searchParams.get('status');
      return json({ sandboxes: rows.filter((r) => !want || r.status === want) });
    }
    if (path === '/v1/sandboxes' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as { class: string; project?: string };
      made.push(body);
      if (o.slowStart) await new Promise((r) => setTimeout(r, o.slowStart));
      // Out of credit refuses a machine that keeps a disk; a temporary one has none.
      if (o.noCredit && body.project) {
        return json({ error: { code: 'insufficient_balance', message: 'No credit left' } }, 402);
      }
      // A machine still starting answers `pending`, and is listed as such.
      const row = { id: `m_${made.length}`, status: o.pending ? 'pending' : 'running', ...body };
      rows.push(row);
      return json(row, 201);
    }
    const pause = path.match(/^\/v1\/sandbox\/([^/]+)\/pause$/);
    if (pause && req.method() === 'POST') {
      stopped.push(pause[1]!);
      const row = rows.find((r) => r.id === pause[1]);
      if (row) row.status = 'parked';
      return json({}, 200);
    }
    const ticket = path.match(/^\/v1\/sandboxes\/([^/]+)\/(terminal|screen)\/ticket$/);
    if (ticket) {
      minted.push(`${ticket[2]}:${ticket[1]}`);
      if (o.ticketFails || failures-- > 0) return json({ error: 'not serving yet' }, 503);
      // A machine still starting has no terminal to open yet.
      if (rows.find((r) => r.id === ticket[1])?.status === 'pending') return json({ error: 'pending' }, 409);
      return json({ url: `/v1/sandbox/${ticket[1]}/${ticket[2]}?ticket=tk` }, 201);
    }
    const door = path.match(/^\/v1\/sandbox\/([^/]+)\/(terminal|screen)$/);
    if (door) {
      // The page inlined by the workspace is fetched with credentials, so it
      // answers CORS for the one origin, and reads its socket the way the cloud's does.
      const doorCors = o.inline
        ? { 'access-control-allow-origin': 'http://127.0.0.1:4321', 'access-control-allow-credentials': 'true' }
        : undefined;
      if (o.inline && door[2] === 'terminal' && req.method() === 'GET') {
        return route.fulfill({
          contentType: 'text/html',
          headers: doorCors,
          body: `<!doctype html><title>t</title><body style="background:#000;color:#0f0">TERMINAL ${door[1]}
<script>
  var socket = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname + '/ws' + location.search;
  var ws = new WebSocket(socket);
</script>
<script>parent.postMessage({ source: 'hanzo-term' }, '*')</script></body>`,
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        headers: doorCors,
        body: doorPage.silent
          ? `<!doctype html><body>SILENT ${door[1]}`
          : door[2] === 'screen'
            ? PAGE('hanzo-screen', `SCREEN ${door[1]}`)
            : PAGE('hanzo-term', `TERMINAL ${door[1]}`),
      });
    }
    return route.fulfill({ status: 404, body: '{}', headers: cors });
  });
  return { made, minted, stopped, plan, door: doorPage, reads };
}

