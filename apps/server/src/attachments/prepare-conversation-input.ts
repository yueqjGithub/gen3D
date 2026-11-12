import { supportedImageMediaTypes } from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import {
  extractDocument,
  MAX_EXTRACTED_DOCUMENT_CHARACTERS,
} from './extract-document';

const imageMediaTypes: ReadonlySet<string> = new Set(supportedImageMediaTypes);

/** 发给 Agent 前整理好的附件内容：文档被提取为文本，图片被转成 data URL。 */
export interface PreparedConversationInput {
  documents: Array<{ fileName: string; mediaType: string; text: string }>;
  images: Array<{ fileName: string; mediaType: string; dataUrl: string }>;
}

/** 所选对话模型不支持图片输入，却上传了图片。 */
export class UnsupportedInlineImageError extends Error {
  constructor() {
    super('The selected chat provider does not document support for inline image input.');
    this.name = 'UnsupportedInlineImageError';
  }
}

// 图片只保存在本地，仅当所选模型支持图片输入时，才以 base64 data URL 的形式内联发送给 Agent
export function toInlineImageDataUrl(mediaType: string, bytes: Uint8Array): string {
  if (!imageMediaTypes.has(mediaType)) {
    throw new TypeError(`Unsupported image media type: ${mediaType}`);
  }
  if (bytes.byteLength === 0) {
    throw new TypeError('Image data cannot be empty.');
  }
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * 读取本轮选中的附件并转换为 Agent 可用的输入：
 * 图片 → data URL；文档 → 提取文本，并限制所有文档合计的字符数，防止上下文过大。
 */
export async function prepareConversationInput(
  attachments: AttachmentStore,
  conversationId: string,
  attachmentIds: string[],
  supportsInlineImages: boolean,
): Promise<PreparedConversationInput> {
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new TypeError('Attachment IDs must be unique.');
  }

  const available = new Map(
    attachments.listByConversation(conversationId).map((attachment) => [attachment.id, attachment]),
  );
  const documents: PreparedConversationInput['documents'] = [];
  const images: PreparedConversationInput['images'] = [];
  let documentCharacters = 0;

  for (const id of attachmentIds) {
    const metadata = available.get(id);
    if (!metadata) {
      throw new Error(`Attachment ${id} does not belong to conversation ${conversationId}.`);
    }
    if (metadata.kind === 'image' && !supportsInlineImages) {
      throw new UnsupportedInlineImageError();
    }

    const bytes = await attachments.read(id);
    if (!bytes) {
      throw new Error(`Attachment data is missing for ${id}.`);
    }

    if (metadata.kind === 'image') {
      images.push({
        fileName: metadata.fileName,
        mediaType: metadata.mediaType,
        dataUrl: toInlineImageDataUrl(metadata.mediaType, bytes),
      });
    } else {
      const { text } = await extractDocument({ mediaType: metadata.mediaType, bytes });
      documentCharacters += text.length;
      if (documentCharacters > MAX_EXTRACTED_DOCUMENT_CHARACTERS) {
        throw new RangeError(
          `Combined document context exceeds ${MAX_EXTRACTED_DOCUMENT_CHARACTERS} characters.`,
        );
      }
      documents.push({ fileName: metadata.fileName, mediaType: metadata.mediaType, text });
    }
  }

  return { documents, images };
}
