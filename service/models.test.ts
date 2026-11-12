// The rules for telling two names of one model apart.
//
// The chat side names a model the way OpenCode does, the local engine names
// the model it holds with the quantization attached, and the two have to be
// recognized as the same model without a table of provider names.
import { describe, expect, test } from 'bun:test';
import { modelDisplayName, normalizeModelId, sameModelId } from '../shared/models';

describe('the identifier', () => {
  test('drops the quantization, the file format and the case', () => {
    expect(normalizeModelId('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS'))
      .toBe('ista-daslab/qwen3.8-flash-next-gsq-rco');
    expect(normalizeModelId('MiniMax-M3.1-Flash')).toBe('minimax-m3.1-flash');
  });

  test('an empty identifier is nothing', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId('   ')).toBe('');
  });
});

describe('one model, two names', () => {
  test('the engine holds the very model the chat is on', () => {
    expect(sameModelId(
      'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF',
      'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS',
    )).toBe(true);
  });

  test('a provider in front of the name does not change the model', () => {
    expect(sameModelId(
      'splash/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF',
      'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS',
    )).toBe(true);
    expect(sameModelId('minimax/MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash')).toBe(true);
  });

  test('a cloud model is not the local one', () => {
    expect(sameModelId(
      'MiniMax-M3.1-Flash',
      'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS',
    )).toBe(false);
    expect(sameModelId(
      'minimax/MiniMax-M3.1-Flash',
      'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS',
    )).toBe(false);
  });

  test('one unknown name matches nothing', () => {
    expect(sameModelId('', 'MiniMax-M3.1-Flash')).toBe(false);
    expect(sameModelId('MiniMax-M3.1-Flash', '')).toBe(false);
  });
});

describe('the name to show', () => {
  test('drops the provider, the organization and the file format', () => {
    expect(modelDisplayName('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF')).toBe('Qwen3.8-Flash-Next-GSQ-RCO');
    expect(modelDisplayName('splash/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF')).toBe('Qwen3.8-Flash-Next-GSQ-RCO');
    expect(modelDisplayName('minimax/MiniMax-M3.1-Flash')).toBe('MiniMax-M3.1-Flash');
    expect(modelDisplayName('MiniMax-M3.1-Flash')).toBe('MiniMax-M3.1-Flash');
  });

  test('a quantization is not part of the name', () => {
    expect(modelDisplayName('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS')).toBe('Qwen3.8-Flash-Next-GSQ-RCO');
  });

  test('an empty identifier is nothing', () => {
    expect(modelDisplayName('')).toBe('');
  });
});
