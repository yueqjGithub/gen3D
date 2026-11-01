import type { ModelMessage, UIMessage, UIMessageChunk } from 'ai';
import type {
  AssetArtifact,
  PersistedMessagePart,
  PreferenceProposal,
} from '@agent3d/shared';

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'error';
}

export interface ChatDataParts extends Record<string, unknown> {
  asset: AssetArtifact;
  activity: ToolActivity;
  turn: { clientTurnId: string };
  preference: PreferenceProposal;
}

export type ChatUIMessage = UIMessage<undefined, ChatDataParts>;
export type ChatUIMessageChunk = UIMessageChunk<undefined, ChatDataParts>;

export interface MastraChatAgent {
  stream(
    messages: ModelMessage[],
    options: { abortSignal?: AbortSignal },
  ): Promise<{
    fullStream: AsyncIterable<unknown> | ReadableStream<unknown>;
    object: Promise<unknown>;
  }>;
}

export interface AdaptedMastraChunk {
  uiChunk: ChatUIMessageChunk | null;
  persistedPart: PersistedMessagePart | null;
  textDelta?: string;
  error?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return null;
  }
  return value.payload;
}

function toolActivity(
  payload: Record<string, unknown>,
  state: ToolActivity['state'],
): AdaptedMastraChunk {
  const toolCallId = readString(payload, 'toolCallId') ?? readString(payload, 'id') ?? 'agent-tool';
  const toolName = readString(payload, 'toolName') ?? 'Agent tool';
  return {
    uiChunk: {
      type: 'data-activity',
      id: toolCallId,
      data: { toolCallId, toolName, state },
    },
    persistedPart: { type: 'tool-activity', toolName, state },
  };
}

export function adaptMastraChunk(chunk: unknown): AdaptedMastraChunk {
  if (!isRecord(chunk) || typeof chunk.type !== 'string') {
    return { uiChunk: null, persistedPart: null };
  }
  const payload = readPayload(chunk) ?? {};
  const id = readString(payload, 'id') ?? 'asset-agent';

  switch (chunk.type) {
    case 'text-start':
      return { uiChunk: { type: 'text-start', id }, persistedPart: null };
    case 'text-delta': {
      const textDelta = readString(payload, 'text');
      return textDelta === null
        ? { uiChunk: null, persistedPart: null }
        : {
          uiChunk: { type: 'text-delta', id, delta: textDelta },
          persistedPart: null,
          textDelta,
        };
    }
    case 'text-end':
      return { uiChunk: { type: 'text-end', id }, persistedPart: null };
    case 'reasoning-start':
      return { uiChunk: { type: 'reasoning-start', id }, persistedPart: null };
    case 'reasoning-delta': {
      const text = readString(payload, 'text');
      return text === null
        ? { uiChunk: null, persistedPart: null }
        : {
          uiChunk: { type: 'reasoning-delta', id, delta: text },
          persistedPart: { type: 'reasoning', text },
        };
    }
    case 'reasoning-end':
      return { uiChunk: { type: 'reasoning-end', id }, persistedPart: null };
    case 'tool-call-input-streaming-start':
      return toolActivity(payload, 'input-streaming');
    case 'tool-call-input-available':
    case 'tool-call':
      return toolActivity(payload, 'input-available');
    case 'tool-call-output-available':
    case 'tool-result':
      return toolActivity(payload, 'output-available');
    case 'tool-call-output-error':
    case 'tool-error':
      return toolActivity(payload, 'error');
    case 'error':
      return { uiChunk: null, persistedPart: null, error: true };
    default:
      return { uiChunk: null, persistedPart: null };
  }
}

export async function* iterateMastraStream(
  stream: AsyncIterable<unknown> | ReadableStream<unknown>,
): AsyncGenerator<unknown> {
  if ('getReader' in stream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        yield result.value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    yield* stream;
  }
}
