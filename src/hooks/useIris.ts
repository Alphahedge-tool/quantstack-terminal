/**
 * The IRIS client — one socket, one conversation, one voice.
 *
 * ── Why the socket is module-scoped ──
 *
 * Same reason as `useLiveQuotes`: the connection must outlive any component.
 * The orb is mounted in AppShell, but alerts have to keep arriving while the
 * user navigates, and a socket owned by a component would re-handshake on every
 * route change — losing the conversation id, and with it the memory that makes
 * follow-up questions work.
 *
 * ── Speaking is opt-in-by-context, not always-on ──
 *
 * Replies are spoken when the question ARRIVED by voice, and stayed silent when
 * it was typed. A terminal that reads every typed answer aloud in an office is
 * a terminal whose users disable the feature within a day. Alerts are the one
 * exception and follow their own setting, because an alert is the case where
 * the user is by definition not looking at the screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveSocket, type SocketState } from '@/lib/socket';
import {
  IRIS_PATH, parseFrame,
  type AlertEvent, type IrisFrame, type Reply, type WatchSummary,
} from '@/lib/iris/protocol';
import { useVoice } from './useVoice';

// ── Module-scoped connection ─────────────────────────────────────────────────

let socket: LiveSocket<IrisFrame> | null = null;

function irisSocket(): LiveSocket<IrisFrame> {
  socket ??= new LiveSocket<IrisFrame>(IRIS_PATH, parseFrame);
  return socket;
}

// ── Conversation model ───────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'iris';
  text: string;
  cards?: Reply['cards'];
  at: number;
  error?: boolean;
  /** True while the turn is in flight — renders the thinking indicator. */
  pending?: boolean;
  /** How the question was asked, so the reply knows whether to speak. */
  viaVoice?: boolean;
}

const GREETING: Message = {
  id: 'seed',
  role: 'iris',
  at: Date.now(),
  text:
    'Ask me about a chain — "what\'s the OI on nifty 25000 CE" — or tell me what to '
    + 'watch: "track OI on nifty 25000 CE and alert me if it moves 5% in 10 minutes".',
};

/** Conversation kept in memory; long histories cost render time, not value. */
const MAX_MESSAGES = 60;

export interface IrisSettings {
  /** Speak replies to questions that were asked by voice. */
  speakReplies: boolean;
  /** Speak alerts when they fire. */
  speakAlerts: boolean;
  /** Raise a browser notification when an alert fires. */
  notify: boolean;
}

const SETTINGS_KEY = 'iris.settings.v1';

function loadSettings(): IrisSettings {
  const fallback: IrisSettings = { speakReplies: true, speakAlerts: true, notify: true };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<IrisSettings>) } : fallback;
  } catch {
    return fallback;
  }
}

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert' | 'offline';

export function useIris() {
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [watches, setWatches] = useState<WatchSummary[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [connection, setConnection] = useState<SocketState>('closed');
  const [thinking, setThinking] = useState(false);
  const [settings, setSettings] = useState<IrisSettings>(loadSettings);

  /**
   * Turns that originated from the microphone.
   *
   * Consulted when the reply lands to decide whether to speak it. A ref because
   * the reply handler is installed once and would otherwise close over the
   * first render's value forever.
   */
  const voiceTurns = useRef<Set<string>>(new Set());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const pushMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
  }, []);

  // ── Voice ───────────────────────────────────────────────────────────────

  /**
   * Declared before `voice` so the recogniser's callback can reach it, and
   * assigned after — `send` needs `voice.shutUp`, and `voice` needs `send`.
   * A ref breaks the cycle without either being stale.
   */
  const sendRef = useRef<(text: string, viaVoice: boolean) => void>(() => {});

  const voice = useVoice({
    onFinal: (text) => sendRef.current(text, true),
    onWake: () => setUnread(0),
  });

  // ── Sending ─────────────────────────────────────────────────────────────

  const send = useCallback((text: string, viaVoice = false) => {
    const clean = text.trim();
    if (!clean) return;

    const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (viaVoice) voiceTurns.current.add(id);

    pushMessage({ id, role: 'user', text: clean, at: Date.now(), viaVoice });
    setThinking(true);
    irisSocket().send({ type: 'ask', id, text: clean });
  }, [pushMessage]);

  sendRef.current = send;

  /** Barge-in: silence the voice and drop whatever is in flight. */
  const interrupt = useCallback(() => {
    voice.shutUp();
    setThinking(false);
  }, [voice]);

  // ── Socket wiring ───────────────────────────────────────────────────────

  useEffect(() => {
    const s = irisSocket();
    s.connect();

    const offState = s.onState(setConnection);

    const offFrame = s.onFrame((frame) => {
      switch (frame.event) {
        case 'watches':
          setWatches(frame.watches);
          break;

        case 'thinking':
          setThinking(true);
          break;

        case 'reply': {
          setThinking(false);
          const reply = frame as Reply & { event: 'reply' };
          pushMessage({
            id: reply.id,
            role: 'iris',
            text: reply.text,
            cards: reply.cards,
            at: Date.now(),
            error: reply.error,
          });

          // Speak only if the matching question came from the microphone. The
          // backend echoes the request id verbatim, so this is an exact match
          // rather than a heuristic — and deleting it here is what stops a
          // typed follow-up from inheriting the previous turn's voice-ness.
          const wasVoice = voiceTurns.current.delete(reply.id);
          if (settingsRef.current.speakReplies && wasVoice && reply.speak) {
            voice.speak(reply.speak);
          }
          // A turn that asked a question re-arms the microphone, so a
          // clarification can be answered without pressing anything.
          if (reply.awaiting && voice.wakeArmed) voice.startListening();
          break;
        }

        case 'alert': {
          const alert = frame.alert;
          setAlerts((prev) => [alert, ...prev].slice(0, 100));
          setUnread((n) => n + 1);

          if (settingsRef.current.speakAlerts && alert.speak) voice.speak(alert.speak);
          if (settingsRef.current.notify) notify(alert);
          break;
        }

        default:
          break;
      }
    });

    return () => { offState(); offFrame(); };
    // `voice` is intentionally omitted: its methods are stable callbacks, and
    // including it would tear down and rebuild the socket listeners on every
    // voice state change — dropping frames mid-reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushMessage]);

  // ── Orb state ───────────────────────────────────────────────────────────

  const orbState: OrbState = useMemo(() => {
    if (connection !== 'open') return 'offline';
    if (voice.state === 'speaking') return 'speaking';
    if (thinking) return 'thinking';
    if (voice.listening) return 'listening';
    if (unread > 0) return 'alert';
    return 'idle';
  }, [connection, voice.state, voice.listening, thinking, unread]);

  // ── Settings ────────────────────────────────────────────────────────────

  const updateSettings = useCallback((patch: Partial<IrisSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const clearUnread = useCallback(() => setUnread(0), []);

  const clearConversation = useCallback(() => {
    setMessages([{ ...GREETING, at: Date.now() }]);
  }, []);

  const refreshWatches = useCallback(() => {
    irisSocket().send({ type: 'watches' });
  }, []);

  return {
    messages,
    watches,
    alerts,
    unread,
    connection,
    thinking,
    orbState,
    settings,
    voice,
    send,
    interrupt,
    updateSettings,
    clearUnread,
    clearConversation,
    refreshWatches,
  };
}

// ── Browser notifications ────────────────────────────────────────────────────

/**
 * Raise a desktop notification for an alert.
 *
 * Permission is requested lazily, on the first alert rather than at mount: a
 * permission prompt that appears the instant a page loads is the one users
 * reflexively deny, and denying it is permanent.
 */
function notify(alert: AlertEvent): void {
  if (typeof Notification === 'undefined') return;

  const show = () => {
    try {
      const n = new Notification(`${alert.target.symbol} ${alert.metric.toUpperCase()}`, {
        body: alert.text,
        // Collapses repeat fires of the same watch into one notification rather
        // than stacking a tower of them.
        tag: alert.watchId,
        silent: false,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers throw when the page is hidden */ }
  };

  if (Notification.permission === 'granted') show();
  else if (Notification.permission === 'default') {
    Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
  }
}
