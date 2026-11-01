import { createTool } from '@mastra/core/tools';
import { supportedImageMediaTypes } from '@agent3d/shared';
import { z } from 'zod';
import type { AttachmentStore } from '../../storage/attachments';
import {
  extractDocument,
  MAX_EXTRACTED_DOCUMENT_CHARACTERS,
} from '../extract-document';

const imageMediaTypes: ReadonlySet<string> = new Set(supportedImageMediaTypes);

export interface PreparedConversationInput {
  documents: Array<{ fileName: string; text: string }>;
  images: Array<{ fileName: string; mediaType: string; dataUrl: string }>;
}

export class UnsupportedInlineImageError extends Error {
  constructor() {
    super('The selected chat provider does not document support for inline image input.');
    this.name = 'UnsupportedInlineImageError';
  }
}

// Images remain local and are sent inline only when the selected provider supports that format.
export function toInlineImageDataUrl(mediaType: string, bytes: Uint8Array): string {
  if (!imageMediaTypes.has(mediaType)) {
    throw new TypeError(`Unsupported image media type: ${mediaType}`);
  }
  if (bytes.byteLength === 0) {
    throw new TypeError('Image data cannot be empty.');
  }
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

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
      documents.push({ fileName: metadata.fileName, text });
    }
  }

  return { documents, images };
}

const analyzeInputSchema = z.object({
  conversationId: z.uuid(),
  attachmentIds: z.array(z.uuid()).max(20),
});

export function createAnalyzeInputTool(
  attachments: AttachmentStore,
  supportsInlineImages: boolean,
) {
  return createTool({
    id: 'analyze-input',
    description: 'Read this conversation’s attached documents and list its already-provided image references.',
    inputSchema: analyzeInputSchema,
    outputSchema: z.object({
      documents: z.array(z.object({
        fileName: z.string(),
        text: z.string().max(MAX_EXTRACTED_DOCUMENT_CHARACTERS),
      })),
      images: z.array(z.object({ fileName: z.string(), mediaType: z.string() })),
    }),
    execute: async ({ conversationId, attachmentIds }) => {
      const input = await prepareConversationInput(
        attachments,
        conversationId,
        attachmentIds,
        supportsInlineImages,
      );
      return {
        documents: input.documents,
        images: input.images.map(({ fileName, mediaType }) => ({ fileName, mediaType })),
      };
    },
  });
}
