import { BRIDGE, inlineHtml, isTerminalPage, sandboxFor, socketOf } from '@/lib/inline';

/** The shape of the cloud terminal page the inliner points: inline scripts, and a
 *  socket address built from the page's own location. */
const PAGE = `<!doctype html><html><body><div id="t"></div>
<script>var term = new Terminal();</script>
<script>
  var socket = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname + '/ws' + location.search;
  var ws = new WebSocket(socket);
</script>
</body></html>`;
const URL_ = 'https://api.hanzo.ai/v1/sandboxes/abc123/terminal?ticket=t1&arg=shell-1';

describe('which pages are inlined', () => {
  it('only the cloud terminal page', () => {
    expect(isTerminalPage(URL_)).toBe(true);
    expect(isTerminalPage('https://api.hanzo.ai/v1/sandbox/abc/terminal')).toBe(true);
    expect(isTerminalPage('https://api.hanzo.ai/v1/sandboxes/abc/screen?ticket=x')).toBe(false);
    expect(isTerminalPage('https://machine.example/ttyd')).toBe(false);
  });

  it('only on the cloud\'s own origin: the same path on another host is refused', () => {
    const path = '/v1/sandboxes/abc123/terminal?ticket=t1';
    expect(isTerminalPage(`https://evil.example${path}`)).toBe(false);
    expect(isTerminalPage(`https://api.hanzo.ai.evil.example${path}`)).toBe(false);
    expect(isTerminalPage(`https://api.hanzo.ai@evil.example${path}`)).toBe(false);
    expect(isTerminalPage(`http://api.hanzo.ai${path}`)).toBe(false);
    expect(isTerminalPage(`https://api.hanzo.ai${path}`)).toBe(true);
    expect(isTerminalPage(`https://other.cloud${path}`, 'https://other.cloud')).toBe(true);
  });

  it('is false for what is not an address', () => {
    expect(isTerminalPage('not a url')).toBe(false);
    expect(isTerminalPage('/v1/sandboxes/abc/terminal')).toBe(false);
  });
});

describe('what an inlined frame may do', () => {
  it('never shares our origin: a blob inherits it, and the page was fetched from the network', () => {
    expect(sandboxFor(true)).not.toContain('allow-same-origin');
    expect(sandboxFor(true).split(' ')).toEqual(['allow-scripts']);
  });

  it('keeps its own origin for a frame served from its own address', () => {
    expect(sandboxFor(false).split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']));
  });
});

describe('the socket a blob document must dial', () => {
  it('is the page address as wss, under /ws, with the ticket kept', () => {
    expect(socketOf(URL_)).toBe('wss://api.hanzo.ai/v1/sandboxes/abc123/terminal/ws?ticket=t1&arg=shell-1');
    expect(socketOf('http://localhost:8080/v1/sandboxes/a/terminal/?t=1')).toBe('ws://localhost:8080/v1/sandboxes/a/terminal/ws?t=1');
  });
});

describe('inlining a terminal page', () => {
  it('points the socket at the minted address', () => {
    const out = inlineHtml(PAGE, URL_, false);
    expect(out).toContain('var socket = "wss://api.hanzo.ai/v1/sandboxes/abc123/terminal/ws?ticket=t1&arg=shell-1";');
    expect(out).not.toContain('location.host');
  });

  it('keeps every script inline: an opaque origin cannot load a blob: script', () => {
    const out = inlineHtml(PAGE, URL_, true);
    expect(out).not.toMatch(/<script[^>]*\ssrc=/);
    expect(out).toContain('var term = new Terminal();');
  });

  it('adds the key bridge before </body> only when asked', () => {
    expect(inlineHtml(PAGE, URL_, true)).toContain(`<script>${BRIDGE}</script></body>`);
    expect(inlineHtml(PAGE, URL_, false)).not.toContain(BRIDGE);
  });

  it('appends the bridge when the page has no </body>', () => {
    expect(inlineHtml(PAGE.replace('</body>', ''), URL_, true).endsWith(`<script>${BRIDGE}</script>`)).toBe(true);
  });

  it('throws for a page whose socket it cannot find, rather than frame a terminal that dials nowhere', () => {
    expect(() => inlineHtml('<html><script>var x = 1;</script></html>', URL_, false)).toThrow(/no socket/);
  });
});
