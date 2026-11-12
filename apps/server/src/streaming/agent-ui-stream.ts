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

/**
 * 自定义的 data-* 流数据类型：渲染进程用 useChat 接收时，会按这些名称得到类型化的 data part。
 *  - asset：生成出的待审批 3D 资产
 *  - activity：工具调用进度
 *  - turn：本轮的 clientTurnId，用于失败重试时去重
 *  - preference：Agent 建议保存的偏好，需用户确认
 */
export interface ChatDataParts extends Record<string, unknown> {
  asset: AssetArtifact;
  activity: ToolActivity;
  turn: { clientTurnId: string };
  preference: PreferenceProposal;
}

export type ChatUIMessage = UIMessage<undefined, ChatDataParts>;
export type ChatUIMessageChunk = UIMessageChunk<undefined, ChatDataParts>;

/** 一次转换的结果：发给渲染进程的 chunk、要写入历史记录的片段，以及累积用的文本增量。 */
export interface AdaptedAgentChunk {
  uiChunk: ChatUIMessageChunk | null;
  persistedPart: PersistedMessagePart | null;
  textDelta?: string;
}

// Mastra 会产生很多内部工具，这里只把用户关心的四个业务工具展示为“活动”，其余忽略
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
 * 把 Mastra 返回的 UI chunk 转成“渲染进程格式 + 历史记录格式”，只保留对用户安全的内容。
 * 文本和推理过程原样透传；工具调用转为 data-activity，并用 toolNamesByCallId
 * 记住 callId 对应的工具名（输出事件里不带工具名）。
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
