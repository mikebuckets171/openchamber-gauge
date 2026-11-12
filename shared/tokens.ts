/**
 * Token counting heuristic.
 *
 * Ported from `opencode-tps-meter` (MIT, ChiR24/opencode-tps-meter,
 * `src/tokenCounter.ts`), which deliberately avoids a real tokenizer: shipping
 * a vocabulary per model family into a bundle that has to load inside a
 * sandboxed guest costs more than a small status readout is worth. The same
 * author puts `chars/4` at about 75% on general text.
 *
 * Provider-reported token counts are always better and replace this as soon
 * as a step settles; the service also learns a correction per model.
 *
 * The service counts characters as deltas arrive and converts only when it
 * reports, so it never holds the streamed text. `ceil` over the accumulated
 * count matches what an incremental counter ends up at.
 */
export const tokensFromChars = (chars: number): number => {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
};
