import { BRIDGE, inlineHtml, isTerminalPage, socketOf } from '@/lib/inline';

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

const blobs = () => {
  const made: string[] = [];
  return { made, script: (code: string) => (made.push(code), `blob:s${made.length}`) };
};

describe('which pages are inlined', () => {
  it('only the cloud terminal page', () => {
    expect(isTerminalPage(URL_)).toBe(true);
    expect(isTerminalPage('https://api.hanzo.ai/v1/sandbox/abc/terminal')).toBe(true);
    expect(isTerminalPage('https://api.hanzo.ai/v1/sandboxes/abc/screen?ticket=x')).toBe(false);
    expect(isTerminalPage('https://machine.example/ttyd')).toBe(false);
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
    const { script, made } = blobs();
    const out = inlineHtml(PAGE, URL_, false, script);
    expect(made.join('\n')).toContain('var socket = "wss://api.hanzo.ai/v1/sandboxes/abc123/terminal/ws?ticket=t1&arg=shell-1";');
    expect(made.join('\n')).not.toContain('location.host');
    expect(out).not.toContain('<script>');
  });

  it('turns every inline script into a script by address, so a webview\'s CSP nonce cannot block it', () => {
    const { script, made } = blobs();
    const out = inlineHtml(PAGE, URL_, false, script);
    expect(made).toHaveLength(2);
    expect(made[0]).toBe('var term = new Terminal();');
    expect(out).toContain('<script src="blob:s1"></script>');
    expect(out).toContain('<script src="blob:s2"></script>');
  });

  it('adds the key bridge before </body> only when asked', () => {
    const on = blobs();
    const withBridge = inlineHtml(PAGE, URL_, true, on.script);
    expect(on.made).toContain(BRIDGE);
    expect(withBridge).toMatch(/<script src="blob:s3"><\/script><\/body>/);
    const off = blobs();
    inlineHtml(PAGE, URL_, false, off.script);
    expect(off.made).not.toContain(BRIDGE);
  });

  it('appends the bridge when the page has no </body>', () => {
    const { script } = blobs();
    expect(inlineHtml(PAGE.replace('</body>', ''), URL_, true, script)).toMatch(/<script src="blob:s3"><\/script>$/);
  });

  it('throws for a page whose socket it cannot find, rather than frame a terminal that dials nowhere', () => {
    expect(() => inlineHtml('<html><script>var x = 1;</script></html>', URL_, false, blobs().script)).toThrow(/no socket/);
  });
});
