/**
 * Minimal single-consumer throttle queue for the news router.
 *
 * Coverage-first means the router can ingest a firehose, but the Telegram Bot
 * API caps roughly ~1 message/second into a single chat (the limit is per-chat,
 * NOT per-topic, so routing into many topics of one group does NOT raise it).
 * Without pacing, bursts trip 429s and event-driven messages are lost forever
 * (no re-poll) — adversarial H1. This queue serializes sends with a minimum gap
 * so we stay under the limit, FIFO so order is preserved.
 *
 * Bounded: if the backlog exceeds `maxQueue` (a sustained firehose the API can't
 * drain), the OLDEST item is dropped with a warning — that's the signal to mute
 * or disable a noisy source, not to lose the newest (most relevant) item.
 *
 * Pure/in-process, no deps — unit-testable with minGapMs:0.
 */

export function createThrottleQueue({ minGapMs = 1100, maxQueue = 500, logger = console, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const q = [];
  let draining = false;
  let lastSentAt = 0;
  let dropped = 0;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (q.length) {
        const gap = minGapMs - (Date.now() - lastSentAt);
        if (gap > 0) await wait(gap);
        const task = q.shift();
        lastSentAt = Date.now();
        try { await task(); }
        catch (err) { logger.warn?.(`[queue] task error (swallowed): ${err?.message || err}`); }
      }
    } finally {
      draining = false;
    }
  }

  return {
    size: () => q.length,
    dropped: () => dropped,
    /** Enqueue an async task. Returns false if the queue dropped an item to fit. */
    enqueue(task) {
      let ok = true;
      if (q.length >= maxQueue) {
        q.shift(); // drop oldest
        dropped += 1;
        ok = false;
        logger.warn?.(`[queue] full (${maxQueue}) — dropped oldest (total dropped ${dropped})`);
      }
      q.push(task);
      // Kick the drain loop (no await — fire and forget; the loop self-paces).
      drain();
      return ok;
    },
  };
}
