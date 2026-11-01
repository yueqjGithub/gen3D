import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  artifactApprovalSchema,
  assetArtifactSchema,
  attachmentBatchSchema,
  agentOutputSchema,
  agentStructuredOutputSchema,
  modelSelectionSchema,
  uploadMetadataSchema,
} from './index';

const validModelSelection = {
  chat: {
    providerId: 'agnes',
    modelId: 'agnes/agnes-3.0-flash',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKeyConfigured: true,
  },
  image: {
    providerId: 'agnes',
    modelId: 'agnes-image-2.5-flash',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKeyConfigured: false,
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
  it('acceptsModelSettingsWithoutCredentialValues', () => {
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
