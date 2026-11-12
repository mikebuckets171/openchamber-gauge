// Model identity: the same model named by two different parties.
//
// The chat side names a model the way OpenCode does — `MiniMax-M3.1-Flash` for a
// cloud route, `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF` for the local one,
// sometimes with the provider in front. The local engine names the model it
// holds with the quantization attached:
// `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS`. The two have to be
// recognized as the same model without a table of provider names, so the
// comparison is done on the tail of the identifier.

/** The identifier without its quantization, its file format and its case. */
export const normalizeModelId = (id: string): string => {
  const trimmed = id.trim();
  if (!trimmed) return '';
  const withoutQuant = trimmed.split(':')[0] ?? '';
  const lower = withoutQuant.toLowerCase();
  return lower.endsWith('-gguf') ? lower.slice(0, -'-gguf'.length) : lower;
};

/**
 * Whether two identifiers name the same model.
 *
 * A provider or an organization in front of the name is tolerated: the tail of
 * the identifier is what names the model, and the tail is what both sides
 * agree on.
 */
export const sameModelId = (a: string, b: string): boolean => {
  const left = normalizeModelId(a);
  const right = normalizeModelId(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

/**
 * The name to show: the model without its provider, its organization, its file
 * format and its quantization.
 */
export const modelDisplayName = (id: string): string => {
  const trimmed = id.trim();
  if (!trimmed) return '';
  const withoutQuant = trimmed.split(':')[0] ?? '';
  const last = withoutQuant.slice(withoutQuant.lastIndexOf('/') + 1);
  return last.replace(/-GGUF$/i, '');
};
