'use client';

/**
 * The AI beside a machine: say what to do, and watch it done on the pane next to
 * this one. It talks to cloud's sandbox agent (`POST /v1/sandbox/:id/agent`),
 * which works the machine through its own tools — a shell, and on a desktop or a
 * browser the screen — and streams each step back. The server keeps nothing
 * between turns, so the conversation lives here and goes back with every turn.
 *
 * The person keeps the machine. Stop ends the turn where it is; Hide puts the
 * panel away and the pane is theirs again, keyboard and all, with the
 * conversation kept for when they open it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square, X } from 'lucide-react';
import { Button, Input, SizableText, XStack, YStack } from '@hanzo/ui';

import type { AgentFrame, AgentTurn } from '../lib/api';

/** One turn's call: what to say and what was said before, with a frame for each step. */
export type AgentRun = (
  body: { message: string; history: AgentTurn[] },
  onFrame: (f: AgentFrame) => void,
  signal: AbortSignal,
) => Promise<void>;

type Line = { who: 'you' | 'ai' | 'step' | 'error'; text: string };

/** A step said as a person would: the tool and what it was asked. */
function step(f: AgentFrame): string {
  const a = (f.args ?? {}) as Record<string, unknown>;
  switch (f.tool) {
    case 'screenshot':
      return 'Looking at the screen';
    case 'click':
      return `Clicking at ${a.x}, ${a.y}`;
    case 'type':
      return `Typing “${String(a.text ?? '').slice(0, 60)}”`;
    case 'key':
      return `Pressing ${a.keys}`;
    case 'scroll':
      return `Scrolling ${Number(a.dy) > 0 ? 'down' : 'up'}`;
    case 'navigate':
      return `Opening ${a.url}`;
    case 'shell':
      return `$ ${String(a.command ?? '').slice(0, 120)}`;
    case 'wait':
      return 'Waiting';
    default:
      return f.tool ?? 'Working';
  }
}

export function AgentPanel({
  run,
  open,
  vertical,
  onHide,
}: {
  run: AgentRun;
  /** Shown, or put away with its conversation kept. */
  open: boolean;
  /** Under the machine rather than beside it: a phone's page. */
  vertical: boolean;
  onHide: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines]);
  useEffect(() => () => stop.current?.abort(), []);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    setBusy(true);
    setLines((l) => [...l, { who: 'you', text: message }]);
    const said: string[] = [];
    const ctl = new AbortController();
    stop.current = ctl;
    try {
      await run(
        { message, history: turns },
        (f) => {
          if (f.type === 'say' && f.text) {
            said.push(f.text);
            setLines((l) => [...l, { who: 'ai', text: f.text! }]);
          } else if (f.type === 'act') {
            setLines((l) => [...l, { who: 'step', text: step(f) }]);
          } else if (f.type === 'result' && f.ok === false && f.text) {
            setLines((l) => [...l, { who: 'step', text: `↳ ${f.text!.split('\n')[0]}` }]);
          } else if (f.type === 'error' && f.text) {
            setLines((l) => [...l, { who: 'error', text: f.text! }]);
          }
        },
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) {
        setLines((l) => [...l, { who: 'error', text: e instanceof Error ? e.message : 'The AI could not be reached.' }]);
      } else {
        setLines((l) => [...l, { who: 'step', text: 'Stopped.' }]);
      }
    } finally {
      setTurns((t) => [...t, { role: 'user', text: message }, ...(said.length ? [{ role: 'assistant' as const, text: said.join('\n\n') }] : [])]);
      stop.current = null;
      setBusy(false);
    }
  }, [draft, busy, run, turns]);

  return (
    <YStack
      display={open ? 'flex' : 'none'}
      width={vertical ? '100%' : 340}
      height={vertical ? '50%' : '100%'}
      shrink={0}
      bg="var(--background)"
      borderColor="var(--border)"
      {...(vertical ? { borderTopWidth: 1 } : { borderLeftWidth: 1 })}
    >
      <XStack height={36} shrink={0} items="center" gap="$2" px="$2.5" borderBottomWidth={1} borderColor="var(--border)">
        <SizableText size="$2" flex={1} numberOfLines={1}>
          {busy ? 'AI is working this machine' : 'AI on this machine'}
        </SizableText>
        {busy ? (
          <Button size="sm" variant="outline" onPress={() => stop.current?.abort()} aria-label="Stop the AI">
            <Square size={12} /> Stop
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onPress={onHide} aria-label="Hide the AI and take control">
          <X size={14} />
        </Button>
      </XStack>

      <YStack flex={1} minH={0} overflow="scroll" px="$2.5" py="$2" gap="$2">
        {lines.length === 0 ? (
          <SizableText size="$2" color="var(--muted-foreground)">
            Say what to do on this machine. You watch it happen on the screen beside, and can stop or take
            the keyboard back at any time.
          </SizableText>
        ) : null}
        {lines.map((l, i) => (
          <SizableText
            key={i}
            size={l.who === 'step' ? '$1' : '$2'}
            color={
              l.who === 'step' ? 'var(--muted-foreground)' : l.who === 'error' ? 'var(--destructive)' : undefined
            }
            fontFamily={l.who === 'step' ? '$mono' : undefined}
            fontWeight={l.who === 'you' ? '600' : undefined}
            whiteSpace="pre-wrap"
          >
            {l.text}
          </SizableText>
        ))}
        <div ref={end} />
      </YStack>

      <XStack shrink={0} gap="$2" p="$2" borderTopWidth={1} borderColor="var(--border)" items="center">
        <Input
          flex={1}
          minW={0}
          value={draft}
          placeholder={busy ? 'Working…' : 'What should it do?'}
          onChangeText={setDraft}
          onSubmitEditing={() => void send()}
          aria-label="Tell the AI what to do"
        />
        <Button size="sm" onPress={() => void send()} disabled={busy || !draft.trim()} aria-label="Send">
          <Send size={14} />
        </Button>
      </XStack>
    </YStack>
  );
}
