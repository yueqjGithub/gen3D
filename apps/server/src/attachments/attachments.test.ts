import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { uploadMetadataSchema } from '@agent3d/shared';
import { extractDocument } from './extract-document';
import {
  prepareConversationInput,
  toInlineImageDataUrl,
  UnsupportedInlineImageError,
} from './prepare-conversation-input';

function createPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 30 80 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];

  let document = '%PDF-1.4\n';
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(document, 'binary');
    document += `${object}\n`;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(document, 'binary');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(document, 'binary'));
}

describe('conversation attachments', () => {
  it('extractsTextMarkdownAndPdfDocuments', async () => {
    await expect(extractDocument({
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('  A carved stone vessel.  '),
    })).resolves.toEqual({ text: 'A carved stone vessel.' });

    await expect(extractDocument({
      mediaType: 'text/markdown',
      bytes: new TextEncoder().encode('# Shape\n\nA round clay bowl.'),
    })).resolves.toEqual({ text: '# Shape\n\nA round clay bowl.' });

    const extractedPdf = await extractDocument({
      mediaType: 'application/pdf',
      bytes: createPdf('A bronze leaf pendant.'),
    });
    expect(extractedPdf.text).toContain('A bronze leaf pendant.');
  });

  it('rejectsMalformedPdfDocuments', async () => {
    await expect(extractDocument({
      mediaType: 'application/pdf',
      bytes: new TextEncoder().encode('not a PDF'),
    })).rejects.toThrow();
  });

  it('rejectsDocumentTextThatExceedsTheAgentContextLimit', async () => {
    await expect(extractDocument({
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('x'.repeat(100_001)),
    })).rejects.toThrow('exceeds 100000 characters');
  });

  it('convertsLocalImageBytesToAnInlineDataUrl', () => {
    expect(toInlineImageDataUrl('image/png', new Uint8Array([1, 2, 3])))
      .toBe('data:image/png;base64,AQID');
    expect(() => toInlineImageDataUrl('application/pdf', new Uint8Array([1])))
      .toThrow();
  });

  it('preparesOnlyAttachmentsOwnedByTheConversation', async () => {
    const conversationId = randomUUID();
    const attachment = uploadMetadataSchema.parse({
      id: randomUUID(),
      conversationId,
      fileName: 'reference.png',
      mediaType: 'image/png',
      size: 3,
      kind: 'image',
      createdAt: new Date().toISOString(),
    });
    const attachments = {
      save: async () => attachment,
      read: async (id: string) => id === attachment.id ? new Uint8Array([1, 2, 3]) : null,
      listByConversation: (id: string) => id === conversationId ? [attachment] : [],
      deleteByConversation: async () => undefined,
    };

    await expect(prepareConversationInput(
      attachments,
      conversationId,
      [attachment.id],
      true,
    ))
      .resolves.toMatchObject({
        images: [{
          fileName: 'reference.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,AQID',
        }],
      });
    await expect(prepareConversationInput(
      attachments,
      randomUUID(),
      [attachment.id],
      true,
    ))
      .rejects.toThrow('does not belong');
    await expect(prepareConversationInput(
      attachments,
      conversationId,
      [attachment.id],
      false,
    )).rejects.toBeInstanceOf(UnsupportedInlineImageError);
  });
});
