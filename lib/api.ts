/**
 * The control plane, read from the browser.
 *
 * Tabs has no backend of its own — deliberately. The machines are already
 * registered with api.hanzo.ai by `hanzo link`, and the terminals are already
 * served by those machines over their own tunnels. A server here would be a third
 * party to a conversation that has two, and one more thing to keep running.
 */

/**
 * Where the control plane answers.
 *
 * A DEFAULT, not a constant, because this module is read by two hosts now: the
 * web app at tabs.hanzo.ai, and the desktop shell, which points at whichever
 * cloud its identity belongs to. Every function here already takes a token, so
 * it takes the origin the same way — a parameter with this as its default,
 * rather than module state a second host would have to remember to set before
 * the first call.
 *
 * `process.env` is read defensively: a bundler that does not define it leaves
 * the identifier undefined rather than an empty object, and reading a property
 * off that throws at module load.
 */
export const API =
  (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_HANZO_API : undefined) ??
  'https://api.hanzo.ai';

export interface Machine {
  id: string;
  label: string;
  host?: string;
  status: string;
  capacity?: string;
}

export interface Session {
  id: string;
  host?: string;
  status: string;
  terminal?: string;
  cwd?: string;
  agent?: string;
  updatedAt?: string;
}

/**
 * A refusal, carrying the platform's own word for it.
 *
 * `code` is what the caller can BRANCH on — being out of credit wants a
 * different answer from a full node, and telling them apart by reading the
 * sentence would break the first time the sentence is reworded.
 */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

/** Out of credit, or past the org's spend cap. Both are answered the same way —
 *  put money on it, or bring a machine of your own — so they are one question. */
export const unfunded = (e: unknown): boolean =>
  e instanceof Refusal && (e.status === 402 || e.code === 'insufficient_balance' || e.code === 'spend_cap_exceeded');

/**
 * Read a refusal off a response, in EITHER shape the fleet sends.
 *
 * The money wire answers `{error:{code,message}}` — an OBJECT — while other
 * endpoints answer `{error:"..."}`. Reading only the flat one coerced the nested
 * object into a string, so the one refusal a person can actually act on
 * rendered as `[object Object]` beside a button that had just failed.
 */
async function refusal(res: Response, fallback: string): Promise<Refusal> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string | { code?: string; message?: string } }
    | null;
  const e = body?.error;
  if (typeof e === 'string') return new Refusal(res.status, '', e || fallback);
  return new Refusal(res.status, e?.code ?? '', e?.message || fallback);
}

async function read<T>(path: string, token: string, origin = API): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const machines = (token: string, origin = API) =>
  read<{ targets: Machine[] }>('/v1/agents/targets', token, origin).then((r) => r.targets ?? []);

export const sessions = (token: string, origin = API) =>
  read<{ sessions: Session[] }>('/v1/agents/sessions?limit=200', token, origin).then(
    (r) => r.sessions ?? [],
  );

/**
 * Sandboxes — the machines we start for you, rather than the ones you linked.
 *
 * The builder's pods (hanzo.app, console.hanzo.ai) serve the same framed
 * terminal every other surface uses: cloud hosts the whole emulator page at
 * /v1/sandboxes/:id/terminal, and the URL's only credential is a single-use,
 * thirty-second ticket. So a sandbox joins this workspace with no new pane
 * kind — it is a machine whose terminal URL is MINTED per open instead of
 * published by `hanzo link`, and `?arg=` names the tmux session exactly as a
 * linked machine's ttyd does.
 *
 * It is the SAME plane as the registry above, which is why there is no second
 * base URL here. A cloud machine used to be a DigitalOcean droplet ordered
 * through visor: a second provisioning plane, a second failure mode, and a
 * minute of boot and `hanzo link` before it could serve a shell. A sandbox is a
 * pod, so the request that asks for one comes back when it is already running.
 */
export interface SandboxMachine {
  id: string;
  status: string;
  project?: string;
  /** `dev` shells; `desktop` also has an X server, so it has a SCREEN to watch.
   *  It is the machine's own answer and not a guess from its name. */
  class?: string;
}

export const sandboxes = (token: string, origin = API) =>
  read<{ sandboxes?: SandboxMachine[] }>('/v1/sandboxes?status=running', token, origin).then((r) =>
    (r.sandboxes ?? []).filter((s) => s.status === 'running'),
  );

/** How a sandbox names itself in the workspace. Its project is what its DISK is
 *  keyed on, so it is the name that means the same box tomorrow. */
export const machineName = (s: SandboxMachine) => s.project || `cloud-${s.id.slice(0, 6)}`;

/** What a machine of each class is called, before its number. It says what the
 *  machine IS — one you shell into, one with a screen — where the name used to
 *  say which product opened it, so a workspace of three read `tabs`, `tabs-2`,
 *  `tabs-3` and told you nothing.
 *
 *  Two stems, not one, because the project keys the DISK and machines are
 *  counted against the ones RUNNING: a stopped `cloud-2` still owns its disk, so
 *  a desktop later handed that name would mount a shell machine's home and call
 *  it a screen. */
const STEM: Record<Class, string> = { dev: 'cloud', desktop: 'desk' };

/** The two machines tabs starts. `dev` is the one you shell into — a toolchain,
 *  a home, and a disk that outlives the lease; `desktop` is that plus an X
 *  server, a window manager and a VNC server, so it has a screen. Neither is
 *  `exec`, the code interpreter's scratch pod, which tabs never opens. */
export type Class = 'dev' | 'desktop';

/**
 * Start one, and answer it once it is RUNNING.
 *
 * A sandbox is named by its project, and the project is what the disk is keyed
 * on: one live sandbox per project is the server's rule, so the name is picked
 * against what is already live rather than made up. That is what makes a second
 * press a second machine instead of a second attempt at the first one.
 *
 * The lease is the server's to set. Tabs has no opinion about how long a machine
 * should live, and a `ttlSec` here would be a second answer to drift from the one
 * in the class table.
 */
export const createSandbox = async (
  token: string,
  kind: Class = 'dev',
  origin = API,
): Promise<SandboxMachine> => {
  const taken = new Set((await sandboxes(token, origin)).map(machineName));
  // Every machine carries its number, the first one included: `cloud` beside
  // `cloud-2` reads as a different kind of thing rather than the one before it.
  // The bound is the pigeonhole — among n machines, one of n+1 names is free.
  const stem = STEM[kind];
  let project = `${stem}-1`;
  for (let n = 2; taken.has(project); n++) project = `${stem}-${n}`;
  let res = await fetch(`${origin}/v1/sandboxes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ class: kind, project }),
    cache: 'no-store',
  });
  // If persistent project disk was rejected with 402 (payment required / unfunded),
  // immediately fallback to a scratch sandbox without persistent project disk,
  // so the user can run free ephemeral sandboxes and live desktops without interruption.
  if (res.status === 402) {
    const scratchRes = await fetch(`${origin}/v1/sandboxes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ class: kind }),
      cache: 'no-store',
    });
    if (scratchRes.ok) {
      return (await scratchRes.json()) as SandboxMachine;
    }
  }
  // Starting a machine fails for reasons a person can act on — no credit, an
  // image that will not pull, a project already held, an org at its ceiling —
  // and the server says which. A bare status code next to the button would name
  // none of them, and the CODE is what lets the pane offer the right remedy.
  if (!res.ok) throw await refusal(res, `new machine → ${res.status}`);
  return (await res.json()) as SandboxMachine;
};

/**
 * Hand a linked machine's tunnel the identity this browser already holds.
 *
 * A published terminal is a shell, so `hanzo link` puts its tunnel behind the
 * org's identity provider. The tunnel used to learn who you are the only way it
 * could — by redirecting to hanzo.id — and hanzo.id will not be framed, quite
 * rightly, because a login page inside someone else's document is clickjacking.
 * So a pane could not open the terminal of a machine belonging to the very
 * person looking at it: the redirect had to leave the frame, and the answer was
 * a second sign-in for a session that already existed.
 *
 * This is that redirect, skipped. The tunnel is asked once, with the token this
 * page is already using to read the registry, and answers with the session it
 * would have set at the end of the round trip. One identity, one sign-in, no
 * tab. The bearer stays in this module; what the workspace gets is a URL.
 *
 * `credentials: 'include'` because the whole point is the cookie that comes
 * back, and `share.hanzo.ai` is a sibling of this page, not a third party.
 */
export const grant = async (token: string, base: string): Promise<void> => {
  const res = await fetch(new URL('/.well-known/zrok/session', base).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
    // Never chase it: a tunnel that answers with a redirect is one that does not
    // know how to be asked, and following it lands on the sign-in page whose
    // absence is the point.
    redirect: 'manual',
    cache: 'no-store',
  });
  if (res.ok) return;
  throw new Error(
    res.type === 'opaqueredirect'
      ? 'terminal grant → the tunnel asked for a sign-in'
      : `terminal grant → ${res.status}`,
  );
};

/** The two ways to look at a machine: its shell, or its screen. Same sandbox,
 *  same credential, two pages — see cloud's apps/sandbox. */
export type Door = 'terminal' | 'screen';

/**
 * Mint a single-use ticket and answer the page to frame.
 *
 * The URL is the SERVER'S, not composed here: the mint answers the path its own
 * ticket opens, so a client cannot spell the address wrong or send a
 * ticket somewhere it does not work. All this adds is the host it was already
 * talking to, and `arg` — the tmux session a terminal attaches to, which a
 * screen has no use for because a machine has one display.
 *
 * The ticket is spent by the first load and lasts thirty seconds, so this is
 * called once per pane per connection, never per render. The bearer never
 * leaves this module: what the workspace holds is the minted URL.
 */
export const frameUrl = async (
  token: string,
  id: string,
  door: Door,
  arg?: string,
  origin = API,
): Promise<string> => {
  const res = await fetch(`${origin}/v1/sandboxes/${encodeURIComponent(id)}/${door}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${door} ticket → ${res.status}`);
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error(`${door} ticket → empty answer`);
  return `${origin}${body.url}` + (arg ? `&arg=${encodeURIComponent(arg)}` : '');
};
