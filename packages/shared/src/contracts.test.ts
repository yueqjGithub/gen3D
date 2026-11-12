import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  artifactApprovalSchema,
  assetArtifactSchema,
  attachmentBatchSchema,
  agentOutputSchema,
  agentStructuredOutputSchema,
  agentChatRequestContextSchema,
  agentServiceHealthSchema,
  agentServiceRequestSchema,
  modelSelectionSchema,
  uploadMetadataSchema,
} from './index';

const validModelSelection = {
  chat: {
    providerId: 'agnes',
    modelId: 'agnes/agnes-3.0-flash',
    baseURL: 'https://apihub.agnes-ai.com/v1',
  },
  image: {
    providerId: 'agnes',
    modelId: 'agnes-image-2.5-flash',
    baseURL: 'https://apihub.agnes-ai.com/v1',
  },
};

const validAttachment = (id: string, size: number, mediaType = 'image/png') => ({
  id,
  conversationId: '123e4567-e89b-42d3-a456-426614174000',
  fileName: `${id}.png`,
  mediaType,
  size,
  kind: mediaType.startsWith('image/') ? 'image' : 'document',
  createdAt: '2026-11-01T00:00:00.000Z',
});

describe('shared model settings', () => {
  it('acceptsModelSelectionWithoutCredentialFields', () => {
    const parsed = modelSelectionSchema.parse(validModelSelection);

    expect(parsed).toEqual(validModelSelection);
    expect(modelSelectionSchema.safeParse({
      ...validModelSelection,
      chat: { ...validModelSelection.chat, apiKey: 'must-not-be-returned' },
    }).success).toBe(false);
  });
});

describe('attachment validation', () => {
  it('rejectsInvalidIdsAndMimeTypes', () => {
    expect(uploadMetadataSchema.safeParse({
      ...validAttachment('not-a-uuid', 4),
    }).success).toBe(false);

    expect(uploadMetadataSchema.safeParse({
      ...validAttachment('123e4567-e89b-42d3-a456-426614174001', 4, 'application/x-msdownload'),
    }).success).toBe(false);
  });

  it('enforcesPerFileAndAggregateLimits', () => {
    const first = validAttachment('123e4567-e89b-42d3-a456-426614174001', 10 * 1024 * 1024);
    const second = validAttachment('123e4567-e89b-42d3-a456-426614174002', 10 * 1024 * 1024);

    expect(attachmentBatchSchema.safeParse([first, second]).success).toBe(true);
    expect(attachmentBatchSchema.safeParse([
      first,
      validAttachment('123e4567-e89b-42d3-a456-426614174002', 10 * 1024 * 1024 + 1),
    ]).success).toBe(false);
    expect(attachmentBatchSchema.safeParse([
      first,
      second,
      validAttachment('123e4567-e89b-42d3-a456-426614174003', 1),
    ]).success).toBe(false);
  });

  it('limitsAttachmentBatchesToTheChatRequestMaximum', () => {
    const attachments = Array.from({ length: 21 }, (_, index) => (
      validAttachment(`123e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`, 1)
    ));

    expect(attachmentBatchSchema.safeParse(attachments).success).toBe(false);
  });
});

describe('agent and artifact validation', () => {
  it('validatesChatAndAssetAgentOutputs', () => {
    const chatOutput = {
      type: 'chat',
      reply: 'Hello! How can I help with a 3D asset?',
    };
    expect(agentOutputSchema.safeParse(chatOutput).success).toBe(true);
    expect(agentStructuredOutputSchema.safeParse({ result: chatOutput }).success).toBe(true);

    const assetOutput = {
      type: 'asset',
      brief: 'A small faceted stone sculpture.',
      script: 'import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()',
      blenderVersion: '4.x',
      preferenceProposals: [{ key: 'style', value: 'faceted', reason: 'Used repeatedly.' }],
    };
    const result = agentOutputSchema.safeParse(assetOutput);

    expect(result.success).toBe(true);
    expect(agentStructuredOutputSchema.safeParse({ result: assetOutput }).success).toBe(true);
    expect(agentOutputSchema.safeParse({
      type: 'asset',
      brief: '',
      script: '',
      blenderVersion: '3.x',
      preferenceProposals: [],
    }).success).toBe(false);
    expect(agentOutputSchema.safeParse({
      type: 'unknown',
      reply: 'Hello',
    }).success).toBe(false);
  });

  it('validatesArtifactApprovalVersion', () => {
    expect(artifactApprovalSchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(artifactApprovalSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(assetArtifactSchema.safeParse({
      id: '123e4567-e89b-42d3-a456-426614174004',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
      version: 1,
      brief: 'A faceted sculpture.',
      script: 'import bpy',
      blenderVersion: '4.x',
      status: 'pending',
      createdAt: '2026-11-01T00:00:00.000Z',
    }).success).toBe(true);
  });
});

describe('Agent service boundary', () => {
  const validRequest = {
    model: {
      providerId: 'agnes',
      modelId: 'agnes/agnes-3.0-flash',
      baseURL: 'https://apihub.agnes-ai.com/v1',
    },
    apiKey: 'example-test-key',
    messages: [{ role: 'user', content: 'Create a small stone sculpture.' }],
    documents: [{ fileName: 'brief.txt', mediaType: 'text/plain', text: 'Low poly, faceted.' }],
    images: [{
      fileName: 'reference.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
    }],
    preferences: [{ key: 'style', value: 'faceted' }],
  };

  it('validatesBoundedAgentRequests', () => {
    expect(agentServiceRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(agentServiceRequestSchema.safeParse({
      ...validRequest,
      model: { ...validRequest.model, protocol: 'unsupported' },
    }).success).toBe(false);
    expect(agentServiceRequestSchema.safeParse({
      ...validRequest,
      messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'hello' })),
    }).success).toBe(false);
    expect(agentServiceRequestSchema.safeParse({
      ...validRequest,
      messages: [{ role: 'system', content: 'not a supported service message' }],
    }).success).toBe(false);
    expect(agentServiceRequestSchema.safeParse({
      ...validRequest,
      messages: [{ role: 'assistant', content: 'No user turn.' }],
    }).success).toBe(false);
  });

  it('acceptsAllAttachmentsAllowedByTheChatRequest', () => {
    const request = {
      ...validRequest,
      documents: Array.from({ length: 9 }, () => validRequest.documents[0]!),
      images: Array.from({ length: 6 }, () => validRequest.images[0]!),
    };

    expect(agentServiceRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejectsAgentRequestsExceedingTheChatAttachmentLimit', () => {
    const request = {
      ...validRequest,
      documents: Array.from({ length: 11 }, () => validRequest.documents[0]!),
      images: Array.from({ length: 10 }, () => validRequest.images[0]!),
    };

    expect(agentServiceRequestSchema.safeParse(request).success).toBe(false);
  });

  it('acceptsAttachmentOnlyTurnsInTheTrustedAgentContext', () => {
    expect(agentChatRequestContextSchema.safeParse({
      model: validRequest.model,
      apiKey: validRequest.apiKey,
      latestUserText: '',
      documents: validRequest.documents,
      images: [{ fileName: 'reference.png', mediaType: 'image/png' }],
      preferences: validRequest.preferences,
    }).success).toBe(true);
  });

  it('acceptsAllAttachmentMetadataAllowedByTheChatRequestContext', () => {
    const context = {
      model: validRequest.model,
      apiKey: validRequest.apiKey,
      latestUserText: 'Create from the attachments.',
      documents: Array.from({ length: 9 }, () => validRequest.documents[0]!),
      images: Array.from({ length: 6 }, () => ({
        fileName: 'reference.png',
        mediaType: 'image/png',
      })),
      preferences: validRequest.preferences,
    };

    expect(agentChatRequestContextSchema.safeParse(context).success).toBe(true);
  });

  it('rejectsRequestContextsExceedingTheChatAttachmentLimit', () => {
    const context = {
      model: validRequest.model,
      apiKey: validRequest.apiKey,
      latestUserText: 'Create from the attachments.',
      documents: Array.from({ length: 11 }, () => validRequest.documents[0]!),
      images: Array.from({ length: 10 }, () => ({
        fileName: 'reference.png',
        mediaType: 'image/png',
      })),
      preferences: validRequest.preferences,
    };

    expect(agentChatRequestContextSchema.safeParse(context).success).toBe(false);
  });

  it('exposesOnlyCredentialFreeHealthStatus', () => {
    expect(agentServiceHealthSchema.parse({ status: 'ready' })).toEqual({ status: 'ready' });
    expect(agentServiceHealthSchema.safeParse({
      status: 'ready',
      apiKey: 'must-not-leak',
    }).success).toBe(false);
  });
});

describe('typed API errors', () => {
  it('serializesTypedErrors', () => {
    expect(apiErrorSchema.parse({
      code: 'PROVIDER_UNCONFIGURED',
      message: 'Configure a provider before chatting.',
      retryable: false,
    })).toEqual({
      code: 'PROVIDER_UNCONFIGURED',
      message: 'Configure a provider before chatting.',
      retryable: false,
    });

    expect(apiErrorSchema.safeParse({
      code: 'PROVIDER_UNCONFIGURED',
      message: 'Configure a provider before chatting.',
      retryable: false,
      stack: 'private stack',
    }).success).toBe(false);
  });
});
