import { useEffect, useMemo, useRef, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import type { Conversation, PreferenceProposal, UploadMetadata } from '@agent3d/shared';
import type { ApiClient } from '../../api/client';
import type { ChatDataParts, ChatUIMessage } from '../../api/types';
import { Composer } from './Composer';
import { MessageParts } from './MessageParts';

export interface ChatViewProps {
  api: ApiClient;
  conversation: Conversation;
  initialMessages: ChatUIMessage[];
  onArtifactChange(artifact: ChatDataParts['asset']): void;
  onOpenAsset(artifactId: string): void;
}

export function ChatView({
  api,
  conversation,
  initialMessages,
  onArtifactChange,
  onOpenAsset,
}: ChatViewProps) {
  const clientTurnId = useRef<string | null>(null);
  const attachmentIds = useRef<string[]>([]);
  const lastArtifactId = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport<ChatUIMessage>({
    api: `${api.baseUrl}/api/chat`,
    headers: api.authHeaders(),
    fetch: api.fetch,
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: {
        ...body,
        conversationId: conversation.id,
        clientTurnId: clientTurnId.current ?? crypto.randomUUID(),
        attachmentIds: attachmentIds.current,
        messages,
      },
    }),
  }), [api, conversation.id]);
  const chat = useChat<ChatUIMessage>({
    id: conversation.id,
    transport,
    messages: initialMessages,
  });
  const { setMessages } = chat;
  const busy = chat.status === 'submitted' || chat.status === 'streaming';

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages, setMessages]);

  useEffect(() => {
    const assets = chat.messages.flatMap((message) =>
      message.parts.flatMap((part) => part.type === 'data-asset' ? [part.data] : []));
    const latest = assets.at(-1);
    if (latest && latest.id !== lastArtifactId.current) {
      lastArtifactId.current = latest.id;
      onArtifactChange(latest);
    }
  }, [chat.messages, onArtifactChange]);

  async function sendMessage(text: string, attachments: UploadMetadata[]) {
    clientTurnId.current = crypto.randomUUID();
    attachmentIds.current = attachments.map(({ id }) => id);
    const parts: ChatUIMessage['parts'] = [];
    if (text) {
      parts.push({ type: 'text', text });
    }
    for (const attachment of attachments) {
      parts.push({
        type: 'data-attachment',
        id: attachment.id,
        data: {
          id: attachment.id,
          fileName: attachment.fileName,
          mediaType: attachment.mediaType,
        },
      });
    }
    setActionError(null);
    await chat.sendMessage({ role: 'user', parts });
  }

  async function retry() {
    if (!clientTurnId.current) {
      setActionError('当前请求没有可重试的会话标识。请重新发送消息。');
      return;
    }
    setActionError(null);
    try {
      await chat.regenerate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '重试失败。');
    }
  }

  async function confirmPreference(proposal: PreferenceProposal) {
    await api.savePreference(proposal.key, proposal.value);
  }

  return (
    <section className="chat-view" aria-label={`${conversation.title} 对话`}>
      <header className="chat-view__header">
        <div>
          <span className="chat-view__eyebrow">资产创作工作台</span>
          <h2>{conversation.title}</h2>
        </div>
        <div className={`chat-view__status chat-view__status--${chat.status}`} role="status">
          {chat.status === 'streaming'
            ? '正在生成'
            : chat.status === 'submitted'
              ? '正在连接'
              : chat.status === 'error'
                ? '生成失败'
                : '就绪'}
        </div>
      </header>

      <div className="chat-view__messages" aria-label="对话消息" aria-live="polite">
        {chat.messages.length === 0 ? (
          <div className="chat-view__empty">
            <span className="chat-view__empty-mark" aria-hidden="true">◌</span>
            <h3>从一个想法开始</h3>
            <p>描述形状、材质或用途，也可以上传图片和文档作为参考。</p>
          </div>
        ) : (
          chat.messages.map((message) => (
            <article
              className={`chat-message chat-message--${message.role}`}
              key={message.id}
              aria-label={message.role === 'user' ? '你的消息' : 'Agent 回复'}
            >
              <span className="chat-message__author">
                {message.role === 'user' ? '你' : '形构 Agent'}
              </span>
              <MessageParts
                message={message}
                onOpenAsset={onOpenAsset}
                onConfirmPreference={confirmPreference}
              />
            </article>
          ))
        )}
      </div>

      {chat.error && (
        <div className="chat-view__error" role="alert">
          <span>{chat.error.message}</span>
          <button type="button" onClick={() => void retry()} disabled={busy}>
            重试
          </button>
        </div>
      )}
      {actionError && <p className="inline-error" role="alert">{actionError}</p>}
      {busy && (
        <button type="button" className="chat-view__stop" onClick={() => void chat.stop()}>
          停止生成
        </button>
      )}

      <Composer
        onUpload={(file) => api.uploadAttachment(conversation.id, file)}
        onSubmit={sendMessage}
        disabled={busy}
      />
    </section>
  );
}
