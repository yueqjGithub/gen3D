import { describe, expect, it } from 'vitest';
import { hasExplicitAssetGenerationIntent } from './asset-generation-intent.js';

describe('hasExplicitAssetGenerationIntent', () => {
  it.each([
    '你好',
    '你能做什么？',
    '如何生成 3D 模型？',
    '不要生成 3D 模型。',
    'Do not generate a 3D model.',
    'Can you generate a 3D model?',
    '你能生成一个 3D 模型吗？',
    '请看看这张参考图片',
    '帮我分析一下这份设计文档',
  ])('does not treat conversational or analysis requests as asset creation: %s', (text) => {
    expect(hasExplicitAssetGenerationIntent(text)).toBe(false);
  });

  it.each([
    '请帮我生成一个低多边形树木模型',
    '创建一个 Blender 3D 道具：木椅',
    '请为我设计一个 3D 角色',
    '你能帮我生成一个低多边形树木模型吗？',
    'Create a 3D prop of a wooden chair',
  ])('recognizes an explicit asset creation request: %s', (text) => {
    expect(hasExplicitAssetGenerationIntent(text)).toBe(true);
  });
});
