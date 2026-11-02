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
