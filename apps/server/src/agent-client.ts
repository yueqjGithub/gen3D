import { randomUUID } from 'node:crypto';
import {
  parseJsonEventStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from 'ai';
import {
  agentChatRequestContextSchema,
  agentServiceRequestSchema,
  type AgentServiceRequest,
} from '@agent3d/shared';

const maxEventLineBytes = 256 * 1024;
const textEncoder = new TextEncoder();

export interface AgentClientOptions {
  baseURL: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface AgentClient {
  stream(
    request: AgentServiceRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<UIMessageChunk>;
}

class AgentClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentClientError';
  }
}

export class AgentServiceUnavailableError extends Error {
  constructor() {
    super('The Agent service is unavailable. Retry the request.');
    this.name = 'AgentServiceUnavailableError';
  }
}

function abortError(): DOMException {
  return new DOMException('The Agent request was aborted.', 'AbortError');
}

function limitSseLineSize(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let lineBytes = 0;
  let eventBytes = 0;
  let lineText = '';
  const decoder = new TextDecoder();
  const checkLines = (text: string) => {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '\n') {
        continue;
      }
      const segment = text.slice(start, index + 1);
      lineBytes += textEncoder.encode(segment).byteLength;
      eventBytes += textEncoder.encode(segment).byteLength;
      lineText += segment.slice(0, -1);
      if (lineBytes > maxEventLineBytes || eventBytes > maxEventLineBytes) {
        throw new AgentClientError('The Agent service returned an oversized event.');
      }
      lineBytes = 0;
      if (lineText === '' || lineText === '\r') {
        eventBytes = 0;
      }
      lineText = '';
      start = index + 1;
    }
    const tail = text.slice(start);
    const tailBytes = textEncoder.encode(tail).byteLength;
    lineBytes += tailBytes;
    eventBytes += tailBytes;
    lineText += tail;
    if (lineBytes > maxEventLineBytes || eventBytes > maxEventLineBytes) {
      throw new AgentClientError('The Agent service returned an oversized event.');
    }
  };
  return stream
    .pipeThrough(new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        checkLines(text);
        controller.enqueue(text);
      },
      flush(controller) {
        const text = decoder.decode();
        checkLines(text);
        if (text) {
          controller.enqueue(text);
        }
      },
    }))
    .pipeThrough(new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(textEncoder.encode(chunk));
      },
    }));
}

async function* readAgentChunks(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<UIMessageChunk> {
  if (!response.body) {
    throw new AgentClientError('The Agent service returned an empty stream.');
  }

  const responseReader = response.body.getReader();
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await responseReader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return responseReader.cancel(reason);
    },
  });
  const parsedStream = parseJsonEventStream({
    stream: limitSseLineSize(source),
    schema: uiMessageChunkSchema,
  });
  const reader = parsedStream.getReader();
  let streamDone = false;
  let finishSeen = false;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
    void responseReader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw abortError();
      }

      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (!value.success) {
        throw new AgentClientError('The Agent service returned an invalid stream chunk.');
      }
      if (finishSeen) {
        throw new AgentClientError('The Agent service sent chunks after its finish chunk.');
      }
      if (value.value.type === 'abort') {
        throw new AgentClientError('The Agent service aborted the request.');
      }
      finishSeen = value.value.type === 'finish';
      yield value.value;
    }

    if (!finishSeen) {
      throw new AgentClientError('The Agent service stream ended without a finish chunk.');
    }
  } catch (error) {
    if (signal.aborted) {
      throw abortError();
    }
    if (error instanceof AgentClientError) {
      throw error;
    }
    throw new AgentClientError('The Agent service returned invalid stream data.');
  } finally {
    signal.removeEventListener('abort', cancelReader);
    if (!streamDone) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
    responseReader.releaseLock();
  }
}

function getLatestUserMessageIndex(request: AgentServiceRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function toAgentMessages(request: AgentServiceRequest, latestUserMessageIndex: number) {
  if (latestUserMessageIndex < 0) {
    throw new AgentClientError('The Agent request must include a user message.');
  }

  return request.messages.map((message, index) => ({
    id: randomUUID(),
    role: message.role,
    parts: [
      { type: 'text' as const, text: message.content },
      ...(index === latestUserMessageIndex
        ? request.images.map((image) => ({
          type: 'file' as const,
          filename: image.fileName,
          mediaType: image.mediaType,
          url: image.dataUrl,
        }))
        : []),
    ],
  }));
}

/**
 * Creates the Hono-to-Agent client; transport and stream errors never expose raw response bodies.
 */
export function createAgentClient({
  baseURL,
  token,
  fetch: fetchImplementation = globalThis.fetch,
}: AgentClientOptions): AgentClient {
  if (!token.trim()) {
    throw new TypeError('The Agent service token must be configured.');
  }
  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/asset-creation-agent`;

  return {
    async *stream(request, { signal }) {
      if (signal.aborted) {
        throw abortError();
      }
      const validatedRequest = agentServiceRequestSchema.parse(request);
      const latestUserMessageIndex = getLatestUserMessageIndex(validatedRequest);
      if (latestUserMessageIndex < 0) {
        throw new AgentClientError('The Agent request must include a user message.');
      }
      const latestUserMessage = validatedRequest.messages[latestUserMessageIndex]!;
      const requestContext = agentChatRequestContextSchema.parse({
        model: validatedRequest.model,
        latestUserText: latestUserMessage.content,
        documents: validatedRequest.documents,
        images: validatedRequest.images.map(({ fileName, mediaType }) => ({ fileName, mediaType })),
        preferences: validatedRequest.preferences,
      });

      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'X-Agent3D-Agent-Token': token,
          },
          body: JSON.stringify({
            messages: toAgentMessages(validatedRequest, latestUserMessageIndex),
            requestContext: { agent3d: requestContext },
          }),
          signal,
        });
      } catch {
        if (signal.aborted) {
          throw abortError();
        }
        throw new AgentServiceUnavailableError();
      }

      if (!response.ok) {
        throw new AgentClientError('The Agent service rejected the request.');
      }

      yield* readAgentChunks(response, signal);
    },
  };
}
