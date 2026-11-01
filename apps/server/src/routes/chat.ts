import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  agentStructuredOutputSchema,
  chatMessageSchema,
  type ChatMessage,
  type ModelConfig,
  type PersistedMessagePart,
  type UploadMetadata,
} from '@agent3d/shared';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
} from 'ai';
import { z } from 'zod';
import type { ResolvedModelConfig } from '../config/model-resolver';
import { prepareConversationInput } from '../agent/tools/analyze-input';
import { ProviderNotConfiguredError } from '../config/model-resolver';
import type { AttachmentStore } from '../storage/attachments';
import type { createArtifactRepository } from '../storage/artifacts';
import type { createConversationRepository } from '../storage/conversations';
import { ChatTurnConflictError } from '../storage/conversations';
import { HttpError } from '../http-errors';
import {
  adaptMastraChunk,
  iterateMastraStream,
  type ChatDataParts,
  type ChatUIMessage,
  type ChatUIMessageChunk,
  type MastraChatAgent,
} from '../streaming/mastra-ui-stream';
import type { createSettingsRepository } from '../config/settings-repository';
import { parseAgentOutput } from '../agent/tools/generate-blender-script';

type ConversationRepository = ReturnType<typeof createConversationRepository>;
type ArtifactRepository = ReturnType<typeof createArtifactRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(8000),
});
const filePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().max(100).optional(),
  filename: z.string().max(255).optional(),
  url: z.string().max(15 * 1024 * 1024).optional(),
});
const attachmentReferenceSchema = z.object({
  type: z.literal('data-attachment'),
  data: z.object({
    id: z.uuid(),
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(100),
  }).strict(),
});
const submittedMessageSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.unknown()).max(100),
});
const chatRequestSchema = z.object({
  conversationId: z.uuid(),
  clientTurnId: z.uuid(),
  messages: z.array(submittedMessageSchema).min(1).max(100),
  attachmentIds: z.array(z.uuid()).max(20),
}).strict();

export interface ChatRouteDependencies {
  conversations: ConversationRepository;
  artifacts: ArtifactRepository;
  attachments: AttachmentStore;
  settings: SettingsRepository;
  resolveModel(selection: ModelConfig, role: 'chat'): Promise<ResolvedModelConfig>;
  createAgent(model: ResolvedModelConfig): MastraChatAgent;
}

function messageText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => part.type === 'text' ? [part.text] : [])
    .join('\n');
}

function readSubmittedTurn(
  messages: z.infer<typeof submittedMessageSchema>[],
  attachmentIds: string[],
  availableAttachments: UploadMetadata[],
): { text: string; userParts: PersistedMessagePart[] } {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new HttpError(400, 'VALIDATION_FAILED', 'The last chat message must be from the user.');
  }

  const submittedParts = z.array(z.union([
    textPartSchema,
    filePartSchema,
    attachmentReferenceSchema,
  ])).max(30)
    .parse(lastMessage.parts);
  const textParts = submittedParts.flatMap((part) => part.type === 'text' ? [part.text] : []);
  const submittedFiles = submittedParts.filter((part) => part.type === 'file');
  const submittedReferences = submittedParts
    .filter((part) => part.type === 'data-attachment');
  if (
    (submittedFiles.length !== 0 && submittedFiles.length !== attachmentIds.length)
    || (submittedReferences.length !== 0 && submittedReferences.length !== attachmentIds.length)
  ) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded file references do not match this request.');
  }
  const attachmentMap = new Map(availableAttachments.map((item) => [item.id, item]));
  const attachmentParts: PersistedMessagePart[] = attachmentIds.map((id, index) => {
    const metadata = attachmentMap.get(id);
    if (!metadata) {
      throw new HttpError(
        400,
        'ATTACHMENT_INVALID',
        'An attachment does not belong to this conversation.',
      );
    }

    const submittedFile = submittedFiles[index];
    const submittedReference = submittedReferences[index];
    if (
      submittedFile
      && (
        (submittedFile.filename && submittedFile.filename !== metadata.fileName)
        || (submittedFile.mediaType && submittedFile.mediaType !== metadata.mediaType)
      )
    ) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded file metadata does not match.');
    }
    if (
      submittedReference
      && (
        submittedReference.data.id !== id
        || submittedReference.data.fileName !== metadata.fileName
        || submittedReference.data.mediaType !== metadata.mediaType
      )
    ) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded attachment references do not match.');
    }

    return {
      type: 'attachment',
      attachmentId: metadata.id,
      fileName: metadata.fileName,
      mediaType: metadata.mediaType,
    };
  });
  const text = textParts.join('\n').trim();
  if (text.length > 8000) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'A chat message must not exceed 8000 characters.');
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'Attachment IDs must be unique.');
  }
  if (!text && attachmentParts.length === 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Add a message or attach a file before sending.');
  }

  const userParts: PersistedMessagePart[] = [
    ...textParts.filter((part) => part.length > 0).map((textPart) => ({
      type: 'text' as const,
      text: textPart,
    })),
    ...attachmentParts,
  ];
  return { text, userParts };
}

function toModelMessages(
  history: ChatMessage[],
  currentText: string,
  documents: Array<{ fileName: string; text: string }>,
  images: Array<{ fileName: string; dataUrl: string }>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of history) {
    if (message.status !== 'complete') {
      continue;
    }
    const text = messageText(message);
    if (!text) {
      continue;
    }
    if (message.role === 'user') {
      messages.push({ role: 'user', content: text });
    } else {
      messages.push({ role: 'assistant', content: text });
    }
  }

  const attachmentContext = documents.map(({ fileName, text }) =>
    `Attached document "${fileName}":\n${text}`).join('\n\n');
  const currentPrompt = [currentText, attachmentContext]
    .filter(Boolean)
    .join('\n\n');
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: string }
  > = [{
    type: 'text',
    text: currentPrompt || 'The user attached reference images but did not include a message. Ask what they would like to do with them.',
  }];
  for (const image of images) {
    content.push({
      type: 'text',
      text: `Reference image: ${image.fileName}`,
    });
    content.push({ type: 'image', image: image.dataUrl });
  }
  messages.push({ role: 'user', content });
  return messages;
}

function appendStreamPart(
  writer: { write(part: ChatUIMessageChunk): void },
  part: PersistedMessagePart,
  artifact: ReturnType<ArtifactRepository['get']>,
): void {
  if (part.type === 'text') {
    writer.write({ type: 'text-start', id: 'replay-text' });
    writer.write({ type: 'text-delta', id: 'replay-text', delta: part.text });
    writer.write({ type: 'text-end', id: 'replay-text' });
  } else if (part.type === 'reasoning') {
    writer.write({ type: 'reasoning-start', id: 'replay-reasoning' });
    writer.write({ type: 'reasoning-delta', id: 'replay-reasoning', delta: part.text });
    writer.write({ type: 'reasoning-end', id: 'replay-reasoning' });
  } else if (part.type === 'tool-activity') {
    const data: ChatDataParts['activity'] = {
      toolCallId: randomUUID(),
      toolName: part.toolName,
      state: part.state,
    };
    writer.write({ type: 'data-activity', id: data.toolCallId, data });
  } else if (part.type === 'asset' && artifact) {
    writer.write({ type: 'data-asset', id: artifact.id, data: artifact });
  } else if (part.type === 'preference-proposal') {
    writer.write({ type: 'data-preference', data: part.proposal });
  }
}

function replayCompletedTurn(
  turn: ChatMessage,
  clientTurnId: string,
  artifactRepository: ArtifactRepository,
): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: turn.id });
      writer.write({ type: 'data-turn', data: { clientTurnId } });
      for (const part of turn.parts) {
        const artifact = part.type === 'asset'
          ? artifactRepository.get(part.artifactId)
          : null;
        appendStreamPart(writer, part, artifact);
      }
      writer.write({ type: 'finish', finishReason: 'stop' });
      writer.setOutcome({ status: 'completed' });
    },
    onError: () => 'The saved response could not be replayed.',
  });
  return createUIMessageStreamResponse({ stream });
}

function safeStreamError(error: unknown): { message: string; code: 'STREAM_FAILED'; retryable: true } {
  if (error instanceof ProviderNotConfiguredError || error instanceof HttpError) {
    return { message: error.message, code: 'STREAM_FAILED', retryable: true };
  }
  return {
    message: 'The model request failed. Check your model settings and retry.',
    code: 'STREAM_FAILED',
    retryable: true,
  };
}

function logModelRequestFailure(
  error: unknown,
  model: ResolvedModelConfig,
  phase: 'start' | 'stream',
): void {
  const details: {
    providerId: string;
    modelId: string;
    phase: 'start' | 'stream';
    errorName: string;
    statusCode?: number;
  } = {
    providerId: model.providerId,
    modelId: model.modelId,
    phase,
    errorName: error instanceof Error ? error.name : 'unknown error',
  };
  if (
    typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number'
  ) {
    details.statusCode = error.statusCode;
  }
  console.error('Chat model request failed:', details);
}

export function createChatRoutes(dependencies: ChatRouteDependencies) {
  const {
    conversations,
    artifacts,
    attachments,
    settings,
    resolveModel,
    createAgent,
  } = dependencies;
  const routes = new Hono();

  routes.post('/chat', async (context) => {
    const body = chatRequestSchema.parse(await context.req.json());
    const conversation = conversations.get(body.conversationId);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

    const input = readSubmittedTurn(
      body.messages,
      body.attachmentIds,
      attachments.listByConversation(conversation.id),
    );
    const userMessage = chatMessageSchema.parse({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      parts: input.userParts,
      createdAt: new Date().toISOString(),
      status: 'complete',
    });

    const existing = conversations.getTurn(conversation.id, body.clientTurnId);
    if (existing?.state === 'complete') {
      const replay = conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
      if (replay.assistantMessage) {
        return replayCompletedTurn(replay.assistantMessage, body.clientTurnId, artifacts);
      }
    }
    if (existing?.state === 'running') {
      conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
      throw new ChatTurnConflictError(body.clientTurnId);
    }

    const selection = await settings.getModelSelection();
    const resolved = await resolveModel(selection.chat, 'chat');
    const preparedInput = await prepareConversationInput(
      attachments,
      conversation.id,
      body.attachmentIds,
      resolved.supportsInlineImages,
    );

    const turn = conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
    if (turn.state === 'complete' && turn.assistantMessage) {
      return replayCompletedTurn(turn.assistantMessage, body.clientTurnId, artifacts);
    }
    if (turn.state === 'running') {
      throw new ChatTurnConflictError(body.clientTurnId);
    }

    const assistantMessageId = turn.assistantMessage?.id ?? randomUUID();
    let result: Awaited<ReturnType<MastraChatAgent['stream']>>;
    try {
      const agent = createAgent(resolved);
      const history = conversations.listMessages(conversation.id)
        .filter((message) => message.id !== turn.userMessage.id);
      result = await agent.stream(
        toModelMessages(history, input.text, preparedInput.documents, preparedInput.images),
        { abortSignal: context.req.raw.signal },
      );
    } catch (error) {
      logModelRequestFailure(error, resolved, 'start');
      const safeError = safeStreamError(error);
      conversations.failTurn(conversation.id, body.clientTurnId, {
        id: assistantMessageId,
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', text: safeError.message }],
        createdAt: new Date().toISOString(),
        status: 'error',
      });
      throw new HttpError(502, safeError.code, safeError.message, safeError.retryable);
    }

    const stream = createUIMessageStream<ChatUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageId: assistantMessageId });
        writer.write({ type: 'data-turn', data: { clientTurnId: body.clientTurnId } });
        const persistedParts: PersistedMessagePart[] = [];
        let streamedText = '';

        try {
          for await (const chunk of iterateMastraStream(result.fullStream)) {
            if (context.req.raw.signal.aborted) {
              throw new DOMException('Request aborted.', 'AbortError');
            }
            const adapted = adaptMastraChunk(chunk);
            if (adapted.error) {
              throw new Error('The model stream reported an error.');
            }
            if (adapted.uiChunk) {
              writer.write(adapted.uiChunk);
            }
            if (adapted.textDelta) {
              streamedText += adapted.textDelta;
            }
            if (adapted.persistedPart) {
              persistedParts.push(adapted.persistedPart);
            }
          }

          if (context.req.raw.signal.aborted) {
            throw new DOMException('Request aborted.', 'AbortError');
          }
          const output = agentStructuredOutputSchema.parse(await result.object).result;
          const assetOutput = output.type === 'asset' ? parseAgentOutput(output) : null;
          const replyText = streamedText.trim()
            || (assetOutput ? assetOutput.brief : output.type === 'chat' ? output.reply : '');
          const resultParts: PersistedMessagePart[] = [];

          if (assetOutput) {
            const artifact = artifacts.createPending({
              conversationId: conversation.id,
              brief: assetOutput.brief,
              script: assetOutput.script,
            });
            writer.write({ type: 'data-asset', id: artifact.id, data: artifact });
            for (const proposal of assetOutput.preferenceProposals) {
              writer.write({ type: 'data-preference', data: proposal });
              resultParts.push({ type: 'preference-proposal', proposal });
            }
            resultParts.unshift({ type: 'asset', artifactId: artifact.id });
          }

          if (!streamedText.trim()) {
            writer.write({ type: 'text-start', id: 'agent-reply' });
            writer.write({ type: 'text-delta', id: 'agent-reply', delta: replyText });
            writer.write({ type: 'text-end', id: 'agent-reply' });
          }
          const assistantMessage = chatMessageSchema.parse({
            id: assistantMessageId,
            conversationId: conversation.id,
            role: 'assistant',
            parts: [
              { type: 'text', text: replyText },
              ...persistedParts,
              ...resultParts,
            ],
            createdAt: new Date().toISOString(),
            status: 'complete',
          });
          conversations.completeTurn(conversation.id, body.clientTurnId, assistantMessage);
          writer.write({ type: 'finish', finishReason: 'stop' });
          writer.setOutcome({ status: 'completed' });
        } catch (error) {
          const aborted = context.req.raw.signal.aborted
            || (error instanceof DOMException && error.name === 'AbortError');
          const safeError = aborted
            ? { message: 'Generation cancelled. Retry when you are ready.' }
            : safeStreamError(error);

          if (!aborted) {
            logModelRequestFailure(error, resolved, 'stream');
          }

          conversations.failTurn(conversation.id, body.clientTurnId, {
            id: assistantMessageId,
            conversationId: conversation.id,
            role: 'assistant',
            parts: [{ type: 'text', text: safeError.message }],
            createdAt: new Date().toISOString(),
            status: 'error',
          });

          if (aborted) {
            writer.setOutcome({ status: 'aborted' });
          } else {
            writer.write({ type: 'error', errorText: safeError.message });
            writer.setOutcome({ status: 'failed', error });
          }
        }
      },
      onError: () => 'The model request failed. Check your model settings and retry.',
    });

    return createUIMessageStreamResponse({ stream });
  });

  return routes;
}
