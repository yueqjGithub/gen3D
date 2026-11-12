import { z } from 'zod';
import { MAX_CONVERSATION_ATTACHMENTS } from './attachments';

/** Maximum extracted text Hono may send for one document. */
export const MAX_AGENT_DOCUMENT_CHARACTERS = 100_000;

const serviceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(50_000),
}).strict();

const serviceModelSchema = z.object({
  providerId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(200),
  baseURL: z.string().url().max(2_048).refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'Model URL must use HTTP or HTTPS',
  ),
}).strict();

const serviceDocumentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(['application/pdf', 'text/markdown', 'text/plain']),
  text: z.string().max(MAX_AGENT_DOCUMENT_CHARACTERS),
}).strict();

const serviceImageSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataUrl: z.string().max(14 * 1024 * 1024)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
}).strict();

const servicePreferenceSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
}).strict();

const agentChatImageMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
}).strict();

/**
 * Trusted, request-scoped values Hono supplies to the native Mastra chat route.
 * Image bytes remain in the AI SDK message parts and are never duplicated here.
 */
export const agentChatRequestContextSchema = z.object({
  model: serviceModelSchema,
  apiKey: z.string().trim().min(1).max(4096),
  latestUserText: z.string().max(50_000),
  documents: z.array(serviceDocumentSchema).max(MAX_CONVERSATION_ATTACHMENTS),
  images: z.array(agentChatImageMetadataSchema).max(MAX_CONVERSATION_ATTACHMENTS),
  preferences: z.array(servicePreferenceSchema).max(50),
}).strict().superRefine((context, refinement) => {
  if (context.documents.length + context.images.length > MAX_CONVERSATION_ATTACHMENTS) {
    refinement.addIssue({
      code: 'custom',
      message: `Attachments exceed ${MAX_CONVERSATION_ATTACHMENTS} per request`,
    });
  }
});

/**
 * Validates the selected model and the prepared conversation data sent only from Hono to Agent.
 */
export const agentServiceRequestSchema = z.object({
  model: serviceModelSchema,
  apiKey: z.string().trim().min(1).max(4096),
  messages: z.array(serviceMessageSchema).min(1).max(40)
    .refine((messages) => messages.some(({ role }) => role === 'user'), {
      message: 'At least one user message is required.',
    }),
  documents: z.array(serviceDocumentSchema).max(MAX_CONVERSATION_ATTACHMENTS),
  images: z.array(serviceImageSchema).max(MAX_CONVERSATION_ATTACHMENTS),
  preferences: z.array(servicePreferenceSchema).max(50),
}).strict().superRefine((request, context) => {
  if (request.documents.length + request.images.length > MAX_CONVERSATION_ATTACHMENTS) {
    context.addIssue({
      code: 'custom',
      message: `Attachments exceed ${MAX_CONVERSATION_ATTACHMENTS} per request`,
    });
  }

  const imageDataBytes = request.images.reduce(
    (total, image) => total + Buffer.byteLength(image.dataUrl, 'utf8'),
    0,
  );
  if (imageDataBytes > 28 * 1024 * 1024) {
    context.addIssue({
      code: 'custom',
      path: ['images'],
      message: 'Inline images exceed the total request limit',
    });
  }
});

/**
 * Returns Agent readiness without exposing internal diagnostics.
 */
export const agentServiceHealthSchema = z.object({
  status: z.literal('ready'),
}).strict();

/** Prepared conversation message passed across the Hono-to-Agent boundary. */
export type AgentServiceMessage = z.infer<typeof serviceMessageSchema>;
/** Selected model metadata sent in the internal request. */
export type AgentServiceModelConfig = z.infer<typeof serviceModelSchema>;
/** Extracted document content prepared by Hono for Agent analysis. */
export type AgentServiceDocument = z.infer<typeof serviceDocumentSchema>;
/** Supported inline image data prepared by Hono for Agent analysis. */
export type AgentServiceImage = z.infer<typeof serviceImageSchema>;
/** Saved preference context passed to Agent without repository access. */
export type AgentServicePreference = z.infer<typeof servicePreferenceSchema>;
/** Trusted context for one native Mastra chat request, excluding inline image bytes. */
export type AgentChatRequestContext = z.infer<typeof agentChatRequestContextSchema>;
/** Validated internal request for one Agent generation turn. */
export type AgentServiceRequest = z.infer<typeof agentServiceRequestSchema>;
/** Validated minimal Agent service health response. */
export type AgentServiceHealth = z.infer<typeof agentServiceHealthSchema>;
