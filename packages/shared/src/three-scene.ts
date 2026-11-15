import { readThreeModel } from './three-model';
import { z } from 'zod';
import { validateBlenderScript } from './blender-script';

// 这是建模工具的业务参数，不是聊天协议。位置、旋转（弧度）、缩放都使用 Three.js 的 XYZ 顺序。
const vector = z.array(z.number().finite().min(-1000).max(1000)).length(3);
export const threeSceneSchema = z.object({
  format: z.literal('three-primitives-v1'),
  objects: z.array(z.object({
    name: z.string().max(100),
    geometry: z.enum(['box', 'sphere', 'cylinder', 'cone', 'torus']),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    position: vector,
    rotation: vector,
    scale: vector.refine(values => values.every(v => v > 0 && v <= 100), 'Scale must be positive and <= 100'),
  })).min(1).max(300),
});
export type ThreeScene = z.infer<typeof threeSceneSchema>;
export function readThreeScene(text: string): ThreeScene | null {
  try { const result = threeSceneSchema.safeParse(JSON.parse(text)); return result.success ? result.data : null; }
  catch { return null; }
}
// 兼容已有 Blender 资产；新资产保存为场景 JSON，数据库不用迁移或重建。
export function validateAssetScript(text: string): { ok: boolean; code?: string } {
  if (readThreeModel(text)) return { ok: true };
  if (text.trimStart().startsWith('{')) return readThreeScene(text) ? { ok: true } : { ok: false, code: 'INVALID_THREE_SCENE' };
  return validateBlenderScript(text);
}
