/**
 * Voice in and out, entirely in the browser.
 *
 * `SpeechRecognition` for listening, `speechSynthesis` for speaking. No cloud
 * STT, no API key, no audio leaving the machine — which matters on a terminal
 * where the microphone is open in a room where positions get discussed.
 *
 * ── The parts of this that are not obvious ──
 *
 * 1. Recognition stops on its own. Every implementation ends the session after
 *    a pause, on an error, and sometimes for no stated reason. Continuous
 *    listening is therefore a RESTART LOOP, not a flag — `continuous = true`
 *    helps but does not remove the need to restart in `onend`.
 *
 * 2. Restarting too eagerly wedges it. Calling `start()` while the engine is
 *    still tearing down throws `InvalidStateError`, and on Chrome a tight
 *    restart loop after a `not-allowed` error will spin forever without ever
 *    producing audio. So restarts are debounced and permission errors latch.
 *
 * 3. Speaking while listening feeds back. The synthesiser's output goes into
 *    the microphone and comes back as a transcript, so the assistant answers
 *    itself. Recognition is therefore suspended for the duration of any
 *    utterance and resumed after — the single most important thing in here.
 *
 * 4. Voices load asynchronously. `getVoices()` is empty on first call in most
 *    browsers and populates on the `voiceschanged` event, so voice selection
 *    has to be deferred rather than read once at module load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Vendor types ─────────────────────────────────────────────────────────────
//
// SpeechRecognition is still unprefixed only in some browsers and is absent
// from TS's DOM lib, so the shapes used are declared locally rather than
// pulling a types package for four members.

interface SpeechRecognitionAlternative { transcript: string; confidence: number }
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * en-IN, not en-US.
 *
 * The vocabulary this engine hears is Indian-market: "banknifty", "lakh",
 * "crore", strike numbers spoken Indian-style. A US model transcribes "two
 * lakh" as "two lack" and the number folder never sees a number.
 */
const LANG = 'en-IN';

/** Debounce before restarting recognition after it ends on its own. */
const RESTART_MS = 300;

/**
 * Wake word.
 *
 * Matched loosely — recognisers render it as "iris", "irish", "eyes", "iris,"
 * — because a missed wake word is a feature that silently does not work, while
 * a false positive merely opens a panel the user can close.
 */
const WAKE = /\b(iris|irish|eye ?ris|iris[,.]?)\b/i;

export type VoiceState = 'idle' | 'listening' | 'speaking' | 'unsupported' | 'denied';

export interface UseVoice {
  supported: boolean;
  state: VoiceState;
  /** Live partial transcript while the user is mid-sentence. */
  interim: string;
  /** True while continuous wake-word listening is armed. */
  wakeArmed: boolean;
  listening: boolean;
  startListening: () => void;
  stopListening: () => void;
  toggleWake: () => void;
  speak: (text: string) => void;
  /** Cut off mid-sentence — barge-in. */
  shutUp: () => void;
  error: string | null;
}

export interface VoiceOptions {
  /** Fired with a final transcript the user actually finished saying. */
  onFinal: (text: string) => void;
  /** Fired when the wake word is heard while only wake-listening. */
  onWake?: () => void;
  /** Speak replies automatically. */
  enabled?: boolean;
}

export function useVoice(opts: VoiceOptions): UseVoice {
  const { onFinal, onWake } = opts;

  const [state, setState] = useState<VoiceState>('idle');
  const [interim, setInterim] = useState('');
  const [wakeArmed, setWakeArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const restartTimer = useRef<number | null>(null);

  /**
   * Why refs and not state for these.
   *
   * The recogniser's callbacks are installed once and captured by closure. If
   * they read React state they would see the values from the render that
   * created them — permanently. Every flag the callbacks consult therefore
   * lives in a ref, and state exists only to drive the UI.
   */
  const wantListening = useRef(false);   // user asked to listen (explicit)
  const wantWake      = useRef(false);   // continuous wake-word mode
  const speaking      = useRef(false);   // suspend recognition while true
  const denied        = useRef(false);   // permission refused — stop retrying
  const onFinalRef    = useRef(onFinal);
  const onWakeRef     = useRef(onWake);

  onFinalRef.current = onFinal;
  onWakeRef.current  = onWake;

  const supported = typeof window !== 'undefined' && recognitionCtor() !== null;

  // ── Recogniser lifecycle ──────────────────────────────────────────────────

  const stopRecognition = useCallback(() => {
    if (restartTimer.current !== null) {
      window.clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    const rec = recognition.current;
    if (!rec) return;
    try { rec.stop(); } catch { /* already stopped */ }
  }, []);

  const startRecognition = useCallback(() => {
    if (denied.current || speaking.current) return;
    const Ctor = recognitionCtor();
    if (!Ctor) { setState('unsupported'); return; }

    // Reuse one instance. Creating a recogniser per start leaks them in
    // Chrome and eventually stops producing results altogether.
    let rec = recognition.current;
    if (!rec) {
      rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = LANG;
      rec.maxAlternatives = 1;
      recognition.current = rec;

      rec.onstart = () => {
        setError(null);
        if (!speaking.current) setState('listening');
      };

      rec.onresult = (e) => {
        let finalText = '';
        let partial = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const text = result[0]?.transcript ?? '';
          if (result.isFinal) finalText += text;
          else partial += text;
        }

        setInterim(partial);

        if (!finalText.trim()) return;
        const said = finalText.trim();
        setInterim('');

        // Wake-only mode: everything is discarded until the wake word lands,
        // and only the text AFTER it is treated as the request. "Hey Iris,
        // what's the OI on nifty" must not send the greeting as the question.
        if (wantWake.current && !wantListening.current) {
          const match = WAKE.exec(said);
          if (!match) return;
          onWakeRef.current?.();
          const after = said.slice((match.index ?? 0) + match[0].length).trim();
          if (after) onFinalRef.current(after);
          return;
        }

        // Explicit listening: strip a leading wake word if the user said one
        // out of habit, then send whatever is left.
        const cleaned = said.replace(WAKE, '').replace(/^[,.\s]+/, '').trim();
        if (cleaned) onFinalRef.current(cleaned);
      };

      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          denied.current = true;
          wantListening.current = false;
          wantWake.current = false;
          setWakeArmed(false);
          setState('denied');
          setError('Microphone permission was refused.');
          return;
        }
        // `no-speech` and `aborted` are routine — the engine simply heard
        // nothing. Surfacing those as errors would keep an error banner up
        // during normal silence.
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          setError(`Speech recognition: ${e.error}`);
        }
      };

      rec.onend = () => {
        setInterim('');
        // Restart if we still want to be listening. Debounced — an immediate
        // start() during teardown throws and leaves recognition dead.
        const shouldRun = (wantListening.current || wantWake.current) && !speaking.current;
        if (!shouldRun || denied.current) {
          setState((s) => (s === 'speaking' ? s : 'idle'));
          return;
        }
        restartTimer.current = window.setTimeout(() => {
          restartTimer.current = null;
          try { recognition.current?.start(); } catch { /* races a manual stop */ }
        }, RESTART_MS);
      };
    }

    try {
      rec.start();
    } catch {
      // Already running — which is fine and is the common case when the wake
      // loop and an explicit start race.
    }
  }, []);

  // ── Public controls ───────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (denied.current) { setState('denied'); return; }
    wantListening.current = true;
    setState('listening');
    startRecognition();
  }, [startRecognition]);

  const stopListening = useCallback(() => {
    wantListening.current = false;
    setInterim('');
    // Wake mode survives an explicit stop: the user is done dictating but the
    // orb should still answer to its name.
    if (!wantWake.current) {
      stopRecognition();
      setState('idle');
    }
  }, [stopRecognition]);

  const toggleWake = useCallback(() => {
    if (denied.current) { setState('denied'); return; }
    const next = !wantWake.current;
    wantWake.current = next;
    setWakeArmed(next);
    if (next) startRecognition();
    else if (!wantListening.current) { stopRecognition(); setState('idle'); }
  }, [startRecognition, stopRecognition]);

  // ── Speech synthesis ──────────────────────────────────────────────────────

  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      // Prefer an Indian-English voice so numbers and symbol names are said the
      // way the user expects; fall back to any English voice, then to whatever
      // the platform gives.
      voice.current =
           voices.find((v) => v.lang === 'en-IN')
        ?? voices.find((v) => v.lang?.startsWith('en-IN'))
        ?? voices.find((v) => v.lang?.startsWith('en-GB'))
        ?? voices.find((v) => v.lang?.startsWith('en'))
        ?? voices[0]
        ?? null;
    };

    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, []);

  const shutUp = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    speaking.current = false;
    if (wantListening.current || wantWake.current) {
      setState('listening');
      startRecognition();
    } else {
      setState('idle');
    }
  }, [startRecognition]);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const clean = text.trim();
    if (!clean) return;

    // Cancel whatever is queued: a burst of alerts should say the newest, not
    // read a backlog nobody is waiting for any more.
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(clean);
    if (voice.current) utter.voice = voice.current;
    utter.lang = voice.current?.lang || LANG;
    // Slightly quick: market commentary read at default rate feels sluggish
    // when you are watching a number move.
    utter.rate = 1.06;
    utter.pitch = 1;

    utter.onstart = () => {
      speaking.current = true;
      setState('speaking');
      // Suspend the microphone — see the header. Without this the synthesiser
      // dictates its own reply back into the recogniser.
      stopRecognition();
    };

    const finish = () => {
      speaking.current = false;
      if (wantListening.current || wantWake.current) {
        setState('listening');
        startRecognition();
      } else {
        setState('idle');
      }
    };

    utter.onend = finish;
    utter.onerror = finish;

    window.speechSynthesis.speak(utter);
  }, [startRecognition, stopRecognition]);

  // ── Teardown ──────────────────────────────────────────────────────────────

  useEffect(() => () => {
    wantListening.current = false;
    wantWake.current = false;
    if (restartTimer.current !== null) window.clearTimeout(restartTimer.current);
    try { recognition.current?.abort(); } catch { /* nothing to abort */ }
    recognition.current = null;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  return {
    supported,
    state: supported ? state : 'unsupported',
    interim,
    wakeArmed,
    listening: state === 'listening',
    startListening,
    stopListening,
    toggleWake,
    speak,
    shutUp,
    error,
  };
}
