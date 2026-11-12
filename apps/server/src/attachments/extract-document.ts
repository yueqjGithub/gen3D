import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  MAX_AGENT_DOCUMENT_CHARACTERS,
  MAX_ATTACHMENT_BYTES,
} from '@agent3d/shared';

export interface DocumentInput {
  mediaType: string;
  bytes: Uint8Array;
}

export interface ExtractedDocument {
  text: string;
}

export const MAX_EXTRACTED_DOCUMENT_CHARACTERS = MAX_AGENT_DOCUMENT_CHARACTERS;

/** 清理并校验提取出的文本：不能为空，也不能超过上限。 */
function validateExtractedText(text: string): ExtractedDocument {
  const normalized = text.trim();
  if (!normalized) {
    throw new TypeError('Document does not contain any text.');
  }
  if (normalized.length > MAX_EXTRACTED_DOCUMENT_CHARACTERS) {
    throw new RangeError(
      `Extracted document text exceeds ${MAX_EXTRACTED_DOCUMENT_CHARACTERS} characters.`,
    );
  }
  return { text: normalized };
}

/**
 * 从文档中提取纯文本：txt/md 直接按 UTF-8 解码；PDF 用 pdfjs 逐页读取文字。
 * 注意：扫描版 PDF（只有图片）提取不到文字，会因“没有文本”而报错。
 */
export async function extractDocument({
  mediaType,
  bytes,
}: DocumentInput): Promise<ExtractedDocument> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RangeError('Document size is outside the supported range.');
  }

  if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
    return validateExtractedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  if (mediaType !== 'application/pdf') {
    throw new TypeError(`Unsupported document media type: ${mediaType}`);
  }

  // pdfjs 会持有内部资源，用完必须 destroy
  const loadingTask = getDocument({ data: bytes });
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .flatMap((item) => ('str' in item && item.str ? [item.str] : []))
        .join(' ')
        .trim();
      if (pageText) {
        pages.push(pageText);
      }
    }

    return validateExtractedText(pages.join('\n\n'));
  } finally {
    await loadingTask.destroy();
  }
}
