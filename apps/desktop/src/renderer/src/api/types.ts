import type { UIMessage } from 'ai';
import type {
  AssetArtifact,
  PreferenceProposal,
} from '@agent3d/shared';

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
