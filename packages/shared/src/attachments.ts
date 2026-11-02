import { z } from 'zod';

/** 单个附件允许的最大字节数（10 MiB）。 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 同一会话下所有附件的累计大小上限（20 MiB）。 */
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 单条消息最多可发送的附件数量。 */
export const MAX_CONVERSATION_ATTACHMENTS = 20;

/** 上传 API 接受的图片和文档 MIME 类型白名单。 */
export const supportedMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/markdown',
  'text/plain',
] as const;

/** 可作为视觉输入处理的 MIME 类型子集。 */
export const supportedImageMediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

const imageMediaTypes = new Set<string>(supportedImageMediaTypes);

/** 附件上传成功后返回的元数据结构；不包含附件文件字节。 */
export const uploadMetadataSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  fileName: z.string().trim().min(1).max(255)
    .refine((value) => !value.includes('/') && !value.includes('\\'), 'File name cannot contain a path'),
  mediaType: z.enum(supportedMediaTypes),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  kind: z.enum(['image', 'document']),
  createdAt: z.iso.datetime(),
}).strict().superRefine((metadata, context) => {
  const expectedKind = imageMediaTypes.has(metadata.mediaType) ? 'image' : 'document';
  if (metadata.kind !== expectedKind) {
    context.addIssue({
      code: 'custom',
      path: ['kind'],
      message: `Expected ${expectedKind} for ${metadata.mediaType}`,
    });
  }
});

/**
 * 一组会话附件的校验规则，同时限制总大小并拒绝重复附件 ID。
 * 单个文件的格式和大小由 `uploadMetadataSchema` 校验。
 */
export const attachmentBatchSchema = z.array(uploadMetadataSchema)
  .max(MAX_CONVERSATION_ATTACHMENTS)
  .superRefine((attachments, context) => {
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (totalBytes > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `Attachments exceed ${MAX_CONVERSATION_ATTACHMENT_BYTES} bytes per conversation`,
      });
    }

    const attachmentIds = new Set<string>();
    for (const [index, attachment] of attachments.entries()) {
      if (attachmentIds.has(attachment.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Attachment IDs must be unique',
        });
      }
      attachmentIds.add(attachment.id);
    }
  });

/** 通过 `uploadMetadataSchema` 校验后的单个附件元数据类型。 */
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;
