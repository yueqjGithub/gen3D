import { z } from 'zod';

/** 本地 API 对外返回的错误格式，确保客户端只依赖稳定错误码和安全提示。 */
export const apiErrorSchema = z.object({
  code: z.enum([
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'CONFLICT',
    'ATTACHMENT_INVALID',
    'ATTACHMENT_TOO_LARGE',
    'UNSUPPORTED_CAPABILITY',
    'UNAUTHORIZED',
    'PROVIDER_UNCONFIGURED',
    'PROVIDER_ERROR',
    'STREAM_FAILED',
    'INTERNAL_ERROR',
  ]),
  message: z.string().trim().min(1).max(1000),
  retryable: z.boolean(),
}).strict();

/** 通过 `apiErrorSchema` 校验后的 API 错误类型。 */
export type ApiError = z.infer<typeof apiErrorSchema>;
