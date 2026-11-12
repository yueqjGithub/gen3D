import { z } from 'zod';

/** 单个模型选择；API Key 由客户端单独保存，不包含在此配置中。 */
export const modelConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(200),
  baseURL: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, 'Base URL must use HTTP or HTTPS'),
}).strict();

/** 聊天模型与生图模型各自独立的选择配置。 */
export const modelSelectionSchema = z.object({
  chat: modelConfigSchema,
  image: modelConfigSchema,
}).strict();

/** 通过 `modelConfigSchema` 校验后的单个模型配置类型。 */
export type ModelConfig = z.infer<typeof modelConfigSchema>;
/** 通过 `modelSelectionSchema` 校验后的聊天/生图模型配置类型。 */
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
