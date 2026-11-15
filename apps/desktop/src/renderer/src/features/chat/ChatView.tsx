import { useEffect, useMemo, useRef, useState } from 'react';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import type { Conversation, UploadMetadata } from '@agent3d/shared';
import { api } from '../../api/client';
import type { ChatDataParts, ChatUIMessage } from '../../api/types';
import { Composer } from './Composer';
import { MessageParts } from './MessageParts';
import { useModelSettings } from '../settings/ModelContext';

export interface ChatViewProps {
  conversation: Conversation;
  initialMessages: ChatUIMessage[];
  onArtifactChange(artifact: ChatDataParts['asset']): void;
  onOpenAsset(artifactId: string): void;
  onOpenModelSettings(): void;
}

/** 一个会话对应一个 useChat 实例；父组件切换会话时通过 key 重建此组件。 */
export function ChatView({
  conversation,
  initialMessages,
  onArtifactChange,
  onOpenAsset,
  onOpenModelSettings,
}: ChatViewProps) {
  const { selection, apiKeys, error: modelError } = useModelSettings();
  const model = selection?.chat ?? null;
  const apiKey = model ? apiKeys[`${model.providerId}:${model.modelId}`] ?? '' : '';
  // useChat 保留同一个 transport；ref 让每次发送和重试都读取最新选择。
  const modelRef = useRef({ model, apiKey });
  modelRef.current = { model, apiKey };
  const clientTurnId = useRef<string | null>(null);
  const attachmentIds = useRef<string[]>([]);
  const lastArtifactId = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // useChat 负责消费流；这里把当前会话、轮次和附件 ID 带到每次聊天请求中。
  // 重试沿用同一个 clientTurnId，服务端才能识别同一轮请求，避免重复保存。
  // 历史消息由服务端从数据库读取，所以请求里只带最后一条（本轮用户消息），避免请求体随对话增长。
  const transport = useMemo(() => new DefaultChatTransport<ChatUIMessage>({
    api: `${api.baseUrl}/api/chat`,
    credentials: 'include',
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: {
        ...body,
        conversationId: conversation.id,
        clientTurnId: clientTurnId.current ?? crypto.randomUUID(),
        attachmentIds: attachmentIds.current,
        model: modelRef.current.model,
        apiKey: modelRef.current.apiKey,
        messages: messages.slice(-1),
      },
    }),
  }), [conversation.id]);
  const chat = useChat<ChatUIMessage>({
    id: conversation.id,
    transport,
    messages: initialMessages,
  });
  const { setMessages } = chat;
  const busy = chat.status === 'submitted' || chat.status === 'streaming';

  // 父组件加载完历史消息后，将其交给 useChat 作为当前消息列表。
  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages, setMessages]);

  // Server 推送的 data-asset 会出现在消息 parts 中，同步给右侧资产面板。
  useEffect(() => {
    const assets = chat.messages.flatMap((message) =>
      message.parts.flatMap((part) => part.type === 'data-asset' ? [part.data] : []));
    const latest = assets.at(-1);
    if (latest && latest.id !== lastArtifactId.current) {
      lastArtifactId.current = latest.id;
      onArtifactChange(latest);
    }
  }, [chat.messages, onArtifactChange]);

  // 消息新增或流式更新时，把消息区滚动到底部。
  const messagesRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  useEffect(() => {
    const el = messagesRef.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, busy]);

  // 上传发生在 Composer 中；聊天请求只携带附件元数据和已上传的附件 ID。
  async function sendMessage(text: string, attachments: UploadMetadata[]) {
    followBottom.current = true;
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
          url: api.baseUrl + '/api/conversations/' + conversation.id + '/attachments/' + attachment.id,
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
    if (!model || !apiKey.trim()) {
      setActionError('请先在模型设置中填写 API Key。');
      return;
    }
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

      <div className="chat-view__messages" ref={messagesRef} onScroll={(event) => { const el = event.currentTarget; followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label="对话消息" aria-live="polite">
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
                pending={busy && message === chat.messages.at(-1) && message.role === 'assistant'}
                onOpenAsset={onOpenAsset}
                onConfirmPreference={async (proposal) => {
                  await api.savePreference(proposal.key, proposal.value);
                }}
              />
            </article>
          ))
        )}
        {/* 发出请求时 assistant 消息可能尚未创建，先在消息列表尾部给出反馈。 */}
        {busy && chat.messages.at(-1)?.role !== 'assistant' && (
          <p className="chat-view__waiting" role="status"><span className="loading-dot" aria-hidden="true" />正在等待 Agent 回复…</p>
        )}
      </div>
      {chat.error && (
        <div className="chat-view__error" role="alert">
          <span>{chat.error.message}</span>
          <button type="button" onClick={() => void retry()} disabled={busy || !apiKey.trim()}>
            重试
          </button>
        </div>
      )}
      {actionError && <p className="inline-error" role="alert">{actionError}</p>}
      <Composer
        onUpload={(file) => api.uploadAttachment(conversation.id, file)}
        onSubmit={sendMessage}
        generating={busy}
        onStop={() => void chat.stop()}
        modelId={model?.modelId ?? null}
        hasApiKey={Boolean(model && apiKey.trim())}
        onOpenModelSettings={onOpenModelSettings}
        modelError={modelError}
      />
    </section>
  );
}
