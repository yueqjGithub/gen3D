import { z } from 'zod';
// 仅描述资产文件，不改变聊天消息协议。客户端导出后上传私有 Storage，source 用于下一轮修改。
export const threeModelSchema = z.object({ format: z.literal('three-script-v1'), source: z.string().min(1).max(100*1024), modelId: z.uuid() });
export type ThreeModel = z.infer<typeof threeModelSchema>;
export function readThreeModel(text: string): ThreeModel | null {
  try { const parsed = threeModelSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; } catch { return null; }
}
