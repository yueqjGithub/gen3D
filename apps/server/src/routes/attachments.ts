import { Hono } from 'hono';
import {
  MAX_ATTACHMENT_BYTES,
  supportedMediaTypes,
} from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import type { createConversationRepository } from '../storage/conversations';
import { extractDocument } from '../attachments/extract-document';
import { HttpError } from '../http-errors';
import { getCookie } from 'hono/cookie';

type ConversationRepository = ReturnType<typeof createConversationRepository>;
// 各类文件的“魔数”（文件头），用来确认文件内容与声明的类型一致，防止改后缀伪装
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** 校验文件内容与 mediaType 是否匹配：图片/PDF 检查文件头，文本必须是合法 UTF-8。 */
function validateFileContent(mediaType: string, bytes: Uint8Array): void {
  if (mediaType === 'image/png' && !startsWithBytes(bytes, pngSignature)) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'The file contents do not match image/png.');
  }
  if (
    mediaType === 'image/jpeg'
    && !(bytes.at(0) === 0xff && bytes.at(1) === 0xd8 && bytes.at(2) === 0xff)
  ) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'The file contents do not match image/jpeg.');
  }
  if (
    mediaType === 'image/webp'
    && (
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'RIFF'
      || Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WEBP'
    )
  ) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'The file contents do not match image/webp.');
  }
  if (mediaType === 'application/pdf') {
    if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'The file contents do not match application/pdf.');
    }
  } else if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Text attachments must contain valid UTF-8.');
    }
  }
}

/** 上传阶段就尝试提取文档文本，提前发现损坏的 PDF / 空文档，并转成清晰的 400 错误。 */
async function validateDocument(mediaType: string, bytes: Uint8Array): Promise<void> {
  try {
    await extractDocument({ mediaType, bytes });
  } catch (error) {
    if (
      mediaType === 'application/pdf'
      && error instanceof Error
      && ['InvalidPDFException', 'FormatError', 'MissingPDFException'].includes(error.name)
    ) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'The PDF file could not be read.');
    }
    if (error instanceof TypeError) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'The document could not be read.');
    }
    throw error;
  }
}

export interface AttachmentRouteDependencies {
  conversations: ConversationRepository;
  attachments: AttachmentStore;
}

/**
 * 附件上传：POST /api/conversations/:id/attachments（multipart/form-data，字段名 file）。
 * 校验顺序：会话存在 → 体积 → 类型白名单 → 文件头 → 文档可读，全部通过后才保存。
 */
export function createAttachmentRoutes({ conversations, attachments }: AttachmentRouteDependencies) {
  const routes = new Hono();

  // 图片预览也验证会话归属，不暴露任意磁盘路径。
  routes.get('/conversations/:id/attachments/:attachmentId', async (context) => {
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    const metadata = conversation && attachments.listByConversation(conversation.id)
      .find(item => item.id === context.req.param('attachmentId'));
    if (!metadata) throw new HttpError(404, 'NOT_FOUND', 'Attachment not found.');
    const bytes = await attachments.read(metadata.id);
    if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'Attachment not found.');
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': metadata.mediaType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  });

  routes.post('/conversations/:id/attachments', async (context) => {
    const conversation = conversations.get(context.req.param('id'), getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

    // 先用 Content-Length 提前拒绝过大的请求（多留 64KB 给 multipart 边界等开销），避免把大文件读进内存
    const contentLength = Number(context.req.header('Content-Length') ?? 0);
    if (contentLength > MAX_ATTACHMENT_BYTES + 64 * 1024) {
      throw new HttpError(
        413,
        'ATTACHMENT_TOO_LARGE',
        `Attachment size must not exceed ${MAX_ATTACHMENT_BYTES} bytes.`,
      );
    }

    const form = await context.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Choose one supported file to upload.');
    }
    if (file.size === 0) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Empty attachments are not supported.');
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(
        413,
        'ATTACHMENT_TOO_LARGE',
        `Attachment size must not exceed ${MAX_ATTACHMENT_BYTES} bytes.`,
      );
    }

    // 浏览器给的 file.type 可能带 charset 参数，这里只取主类型并统一小写后与白名单比较
    const [rawMediaType = ''] = file.type.split(';');
    const mediaType = rawMediaType.trim().toLowerCase();
    if (!(supportedMediaTypes as readonly string[]).includes(mediaType)) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'This file type is not supported.');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    validateFileContent(mediaType, bytes);
    if (mediaType === 'application/pdf') {
      await validateDocument(mediaType, bytes);
    } else if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
      await validateDocument(mediaType, bytes);
    }

    return context.json({
      attachment: await attachments.save(
        conversation.id,
        file.name,
        mediaType,
        bytes,
      ),
    }, 201);
  });

  return routes;
}
