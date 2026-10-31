/**
 * The modem's line out of the browser, as in A-Prompt and Ok-Prompt: a BBS
 * with its own WebSocket gateway is called straight from the page; any
 * other board in the phone book goes through this site's Worker (/relay),
 * which opens the telnet connection. Dialing plays the dial tone, the
 * beeps and the handshake. `ai` / `deepseek` reach the AI board, which
 * lives in the page (when there is one).
 */
import type { Dialer, Link, LinkHandlers, Modem, ModemOptions } from '../c64/modem';
import { inPhoneBook } from '../phonebook';
import { withCallSound } from './call-sound';
import { startCallSound } from './modem-audio';

const MODEM_PROFILE = 'ready-prompt.modem';

/** A call over one WebSocket; `isRelay` waits for the relay's CONNECT frame. */
function wsCall(url: string, protocols: string[], isRelay: boolean, handlers: LinkHandlers): Link {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, protocols);
  } catch {
    queueMicrotask(() => handlers.onClose());
    return { send: () => {}, close: () => {} };
  }
  ws.binaryType = 'arraybuffer';
  if (!isRelay) ws.onopen = () => handlers.onOpen('DIRECT');
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') handlers.onData(new Uint8Array(e.data as ArrayBuffer));
    else if (isRelay && e.data === 'CONNECT') handlers.onOpen();
    else handlers.onData(Uint8Array.from(e.data, c => c.charCodeAt(0) & 0xff));
  };
  ws.onclose = () => handlers.onClose();
  return {
    send: bytes => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); },
    close: () => ws.close(),
  };
}

/** Through the Worker relay (worker/index.ts) on the same origin. */
function relayCall(host: string, port: number, handlers: LinkHandlers): Link {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = `host=${encodeURIComponent(host)}&port=${port}`;
  return wsCall(`${scheme}://${location.host}/relay?${query}`, [], true, handlers);
}

export interface LineDeps {
  /** The AI board, if this page has one. */
  aiBoard?: (handlers: LinkHandlers) => Link;
  /** The modem's speaker settings (ATM, ATL), read when a call starts. */
  speaker(): { on: boolean; volume: number };
}

/** The dialer: a BBS's gateway, else the relay; AI is the AI board. */
export function makeDialer(deps: LineDeps): Dialer {
  const dial: Dialer = (target, handlers) => {
    if ((target.host === 'ai' || target.host === 'deepseek') && deps.aiBoard) return deps.aiBoard(handlers);
    if (!target.ws) return relayCall(target.host, target.port, handlers);
    let current: Link;
    let opened = false;
    let closed = false;
    current = wsCall(target.ws, ['binary'], false, {
      onOpen: info => { opened = true; handlers.onOpen(info); },
      onData: bytes => handlers.onData(bytes),
      onClose: () => {
        if (!opened && !closed && inPhoneBook(target.host, target.port)) {
          current = relayCall(target.host, target.port, handlers);
        } else {
          handlers.onClose();
        }
      },
    });
    return {
      send: bytes => current.send(bytes),
      close: () => { closed = true; current.close(); },
    };
  };
  return withCallSound(dial, target => {
    if (target.host === 'ai' || target.host === 'deepseek') return undefined;
    const s = deps.speaker();
    return s.on ? startCallSound(`${target.host}:${target.port}`, s.volume) : undefined;
  });
}

/** The modem's options for the page, and the setup that loads its AT&W profile. */
export function modemOptions(deps: LineDeps): ModemOptions & { setup(m: Modem): void } {
  return {
    dialer: makeDialer(deps),
    terminalType: () => 'ANSI',
    windowSize: () => [40, 25],
    setup(m) {
      if (deps.aiBoard) m.services = [{ number: 'AI', name: 'AI board: DeepSeek, your API key' }];
      try {
        const saved = localStorage.getItem(MODEM_PROFILE);
        if (saved) m.loadProfile(JSON.parse(saved));
      } catch {
        /* no saved profile */
      }
      m.onSaveProfile = profile => {
        try {
          localStorage.setItem(MODEM_PROFILE, JSON.stringify(profile));
        } catch {
          /* storage blocked */
        }
      };
    },
  };
}
