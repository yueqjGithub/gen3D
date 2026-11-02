import type { UIMessage, UIMessageChunk } from 'ai';
import type {
  PersistedMessagePart,
  PreferenceProposal,
} from '@agent3d/shared';
import type { AssetArtifact } from '@agent3d/shared';

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

export interface AdaptedAgentChunk {
  uiChunk: ChatUIMessageChunk | null;
  persistedPart: PersistedMessagePart | null;
  textDelta?: string;
}

const knownTools = new Set([
  'analyze-input',
  'build-asset-brief',
  'generate-blender-script',
  'update-preferences',
]);

function noChunk(): AdaptedAgentChunk {
  return { uiChunk: null, persistedPart: null };
}

function activityChunk(
  toolCallId: string,
  toolName: string,
  state: ToolActivity['state'],
): AdaptedAgentChunk {
  const activity: ToolActivity = { toolCallId, toolName, state };
  return {
    uiChunk: { type: 'data-activity', id: toolCallId, data: activity },
    persistedPart: { type: 'tool-activity', toolName, state },
  };
}

/**
 * Maps only user-safe content from a Mastra UI chunk into renderer and history formats.
 */
export function adaptAgentChunk(
  chunk: UIMessageChunk,
  toolNamesByCallId = new Map<string, string>(),
): AdaptedAgentChunk {
  switch (chunk.type) {
    case 'text-start':
      return { uiChunk: { type: 'text-start', id: chunk.id }, persistedPart: null };
    case 'text-delta':
      return {
        uiChunk: { type: 'text-delta', id: chunk.id, delta: chunk.delta },
        persistedPart: null,
        textDelta: chunk.delta,
      };
    case 'text-end':
      return { uiChunk: { type: 'text-end', id: chunk.id }, persistedPart: null };
    case 'reasoning-start':
      return { uiChunk: { type: 'reasoning-start', id: chunk.id }, persistedPart: null };
    case 'reasoning-delta':
      return {
        uiChunk: { type: 'reasoning-delta', id: chunk.id, delta: chunk.delta },
        persistedPart: { type: 'reasoning', text: chunk.delta },
      };
    case 'reasoning-end':
      return { uiChunk: { type: 'reasoning-end', id: chunk.id }, persistedPart: null };
    case 'tool-input-start':
      if (!knownTools.has(chunk.toolName)) {
        return noChunk();
      }
      toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
      return activityChunk(chunk.toolCallId, chunk.toolName, 'input-streaming');
    case 'tool-input-available':
    case 'tool-input-error':
      if (!knownTools.has(chunk.toolName)) {
        return noChunk();
      }
      toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
      return activityChunk(
        chunk.toolCallId,
        chunk.toolName,
        chunk.type === 'tool-input-error' ? 'error' : 'input-available',
      );
    case 'tool-output-available':
    case 'tool-output-error': {
      const toolName = toolNamesByCallId.get(chunk.toolCallId);
      if (!toolName) {
        return noChunk();
      }
      const adapted = activityChunk(
        chunk.toolCallId,
        toolName,
        chunk.type === 'tool-output-error' ? 'error' : 'output-available',
      );
      toolNamesByCallId.delete(chunk.toolCallId);
      return adapted;
    }
    default:
      return noChunk();
  }
}
