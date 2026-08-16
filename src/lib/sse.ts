/**
 * Reader for the backend's `progress → result → append` event streams.
 *
 * ── Why these routes stream at all ──
 *
 * `/band-greeks` fetches 60–100 option series and walks a session; `/risk-
 * reversal` fetches ~34 and inverts vols per bar. Both take long enough that a
 * silent request looks hung, so the backend sends `progress` frames while it
 * works and a single `result` at the end. When the session was cached it may
 * also send one `append` carrying the bars recorded since the entry was
 * written.
 *
 * ── Why not EventSource ──
 *
 * EventSource is the obvious tool and the wrong one here, for two reasons that
 * both bite in production rather than in a demo:
 *
 *  1. It RECONNECTS when the stream closes. These routes call `res.end()` after
 *     the result — a normal, successful finish — which EventSource reads as a
 *     dropped connection and retries. On a cache miss that means kicking off
 *     another full basket computation, forever, from a component that thinks it
 *     has finished loading.
 *  2. It cannot be cancelled by an `AbortSignal`, so it does not compose with
 *     TanStack Query's cancellation. Navigating away mid-compute would leave the
 *     stream running.
 *
 * `fetch` with a streamed body has neither problem: it ends when the server
 * ends, and it takes the query's signal directly.
 */

import { z } from 'zod';
import { ApiFailure } from '@/lib/api';

export interface StreamProgress {
  stage: string;
  pct: number;
  message: string;
}

interface StreamOptions<T> {
  signal?: AbortSignal;
  /** Called for each `progress` frame. */
  onProgress?: (progress: StreamProgress) => void;
  /**
   * Folds an `append` frame into the result already received. Returns the
   * merged value. Omit when a route's appends can be ignored.
   */
  merge?: (result: T, append: unknown) => T;
}

/** One `event:`/`data:` pair, as they arrive. */
function* parseFrames(buffer: string): Generator<{ event: string; data: string }> {
  // Frames are separated by a blank line. `\r\n` is tolerated because the spec
  // allows it and a proxy in front of the backend may rewrite line endings.
  for (const block of buffer.split(/\r?\n\r?\n/)) {
    if (!block.trim() || block.startsWith(':')) continue; // `:` is a keep-alive ping
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) yield { event, data: data.join('\n') };
  }
}

export async function streamResult<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  /**
   * Pinned to the schema's OUTPUT type, not `z.ZodType<T>`.
   *
   * These schemas use `.default()`, which makes a field optional going in and
   * guaranteed coming out — so a bare `z.ZodType<T>` lets `T` bind to the input
   * side, and `merge` then receives a value whose defaults are all `| undefined`
   * even though parsing has already filled them. Fixing `unknown` as the input
   * type forces `T` to the parsed shape, which is the only one any caller sees.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: StreamOptions<T> = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }

  const response = await fetch(`${path}?${params}`, {
    headers: { Accept: 'text/event-stream' },
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    // These routes answer a hard failure as plain text, not as the JSON
    // envelope the rest of the API uses, so it is read as text.
    const detail = await response.text().catch(() => '');
    throw new ApiFailure(detail || `Request failed (${response.status})`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | undefined;
  let failure: { message: string; code?: string } | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Keep the trailing partial frame in the buffer — a chunk boundary lands
      // mid-frame often enough that parsing what has arrived would drop data.
      //
      // Found by regex rather than `lastIndexOf('\n\n')`, which does not match
      // a CRLF separator: `\r\n\r\n` does not contain the substring `\n\n`. On
      // a CRLF stream that version never split, so every frame accumulated
      // until the end — the result still arrived, but progress frames were all
      // delivered at once, after the work they were reporting had finished.
      let end = -1;
      const separator = /\r?\n\r?\n/g;
      for (let m = separator.exec(buffer); m !== null; m = separator.exec(buffer)) {
        end = m.index + m[0].length;
      }
      if (end === -1) continue;
      const ready = buffer.slice(0, end);
      buffer = buffer.slice(end);

      for (const frame of parseFrames(ready)) {
        if (frame.event === 'progress') {
          options.onProgress?.(JSON.parse(frame.data) as StreamProgress);
        } else if (frame.event === 'result') {
          result = schema.parse(JSON.parse(frame.data));
        } else if (frame.event === 'append' && result && options.merge) {
          result = options.merge(result, JSON.parse(frame.data));
        } else if (frame.event === 'error') {
          failure = JSON.parse(frame.data) as { message: string; code?: string };
        }
      }
    }
    // Whatever is left after the stream ends — the final frame arrives without
    // a trailing blank line when the server ends the response immediately.
    for (const frame of parseFrames(buffer)) {
      if (frame.event === 'result') result = schema.parse(JSON.parse(frame.data));
      else if (frame.event === 'append' && result && options.merge) {
        result = options.merge(result, JSON.parse(frame.data));
      } else if (frame.event === 'error') failure = JSON.parse(frame.data) as { message: string };
    }
  } finally {
    reader.releaseLock();
  }

  if (failure) {
    // Surfaced with the same `isAuth` contract the JSON client uses, so an
    // expired session renders a sign-in prompt here too rather than a red
    // banner the user cannot act on.
    throw new ApiFailure(failure.message, failure.code === 'FEED_AUTH_REQUIRED' ? 401 : 500, failure.code);
  }
  if (!result) throw new ApiFailure('The stream ended without a result', 502);
  return result;
}
