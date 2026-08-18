/**
 * IRIS — mounted once, present on every page.
 *
 * ── Positioning ──
 *
 * `fixed` bottom-right, above the status bar. The wrapper is
 * `pointer-events-none` and only the orb and the panel re-enable pointer
 * events, so the empty column of space between them never swallows a click
 * meant for the page underneath — the classic failure of a floating widget,
 * and one that is invisible until a user reports "the table stopped working in
 * that corner".
 *
 * ── z-index ──
 *
 * Above panels and charts, below nothing else this app renders. Kept as a
 * single literal here rather than a token because it is the only element in the
 * system that floats over everything; a scale would imply a hierarchy that does
 * not exist.
 */

import { useCallback, useState } from 'react';
import { useIris } from '@/hooks/useIris';
import { api } from '@/lib/api';
import { IrisOrb } from './IrisOrb';
import { IrisPanel } from './IrisPanel';

export function Iris() {
  const [open, setOpen] = useState(false);
  const iris = useIris();

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      // Opening the panel is the user acknowledging whatever was waiting.
      if (next) iris.clearUnread();
      return next;
    });
  }, [iris]);

  const onMic = useCallback(() => {
    // Turning the microphone on opens the panel too: the transcript and the
    // reply need somewhere to land, and an orb that starts listening with no
    // visible conversation leaves the user unsure it heard anything.
    if (!iris.voice.wakeArmed) setOpen(true);
    iris.voice.toggleWake();
  }, [iris]);

  const send = useCallback((text: string) => {
    setOpen(true);
    iris.send(text);
  }, [iris]);

  /**
   * Cancel over REST rather than through the conversation.
   *
   * Clicking ✕ on a watch is a direct manipulation, not a request — routing it
   * through the NLU ("cancel watch w_abc123") would make a deterministic action
   * depend on parsing, and it would put a phantom turn in the transcript.
   */
  const cancelWatch = useCallback(async (id: string) => {
    try {
      await api.del(`/api/assistant/watches?id=${encodeURIComponent(id)}`);
    } catch {
      // Non-fatal: the refresh below re-reads the truth either way, so a failed
      // delete simply leaves the watch visible rather than lying about it.
    }
    iris.refreshWatches();
  }, [iris]);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end"
      data-iris-root
    >
      <IrisPanel
        open={open}
        onClose={() => setOpen(false)}
        messages={iris.messages}
        watches={iris.watches}
        alerts={iris.alerts}
        thinking={iris.thinking}
        connection={iris.connection}
        settings={iris.settings}
        onSettings={iris.updateSettings}
        onSend={send}
        onCancelWatch={cancelWatch}
        onClear={iris.clearConversation}
        interim={iris.voice.interim}
        listening={iris.voice.listening}
      />

      <IrisOrb
        state={iris.orbState}
        unread={iris.unread}
        open={open}
        onClick={toggle}
        onMic={onMic}
        micArmed={iris.voice.wakeArmed}
        micDenied={iris.voice.state === 'denied' || !iris.voice.supported}
      />
    </div>
  );
}
