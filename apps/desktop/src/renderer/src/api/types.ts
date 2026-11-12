import type { UIMessage } from 'ai';
import type {
  AssetArtifact,
  PreferenceProposal,
} from '@agent3d/shared';

// ChatDataParts 描述服务端在 AI SDK 消息流中发送的自定义 data-* 数据。
export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'error';
}

export type ChatDataParts = {
  asset: AssetArtifact;
  activity: ToolActivity;
  turn: { clientTurnId: string };
  preference: PreferenceProposal;
  attachment: { id: string; fileName: string; mediaType: string };
};

// 历史消息的保存状态放在 metadata；实时流消息不一定包含该字段。
export interface ChatMessageMetadata {
  persistedStatus?: 'complete' | 'error';
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts>;

export interface ProviderOption {
  id: string;
  name: string;
  protocol: 'openai-compatible' | 'anthropic';
  baseURL: string;
  supportsInlineImages: boolean;
  models: {
    chat: readonly string[];
    image: readonly string[];
  };
}

export interface ModelSettings {
  providers: ProviderOption[];
  selection: import('@agent3d/shared').ModelSelection;
}

export interface ScriptValidation {
  ok: boolean;
  code?: string;
}

export interface ArtifactDetails {
  artifact: AssetArtifact;
  scriptValidation: ScriptValidation;
}
