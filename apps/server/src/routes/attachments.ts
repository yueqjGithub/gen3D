import { Hono } from 'hono';
import {
  MAX_ATTACHMENT_BYTES,
  supportedMediaTypes,
} from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import type { createConversationRepository } from '../storage/conversations';
import { extractDocument } from '../attachments/extract-document';
import { HttpError } from '../http-errors';

type ConversationRepository = ReturnType<typeof createConversationRepository>;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

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

export function createAttachmentRoutes({ conversations, attachments }: AttachmentRouteDependencies) {
  const routes = new Hono();

  routes.post('/conversations/:id/attachments', async (context) => {
    const conversation = conversations.get(context.req.param('id'));
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

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
