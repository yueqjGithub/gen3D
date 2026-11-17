import { readThreeModel } from '@agent3d/shared';
import ReactMarkdown, { type Components } from 'react-markdown';
import { useState } from 'react';
import type { PreferenceProposal } from '@agent3d/shared';
import type { ChatUIMessage } from '../../api/types';
import { api } from '../../api/client';
import { UserQuestion } from './UserQuestion';

const apiOrigin = new URL(api.baseUrl).origin;
const markdownComponents: Components = {
  img: ({ node, src, ...props }) => {
    // 附件接口通过 Cookie 识别用户。按协议、主机和端口匹配 API，避免误认相似域名。
    const isApiImage = src && URL.parse(src, document.baseURI)?.origin === apiOrigin;
    return <img {...props} src={src} crossOrigin={isApiImage ? 'use-credentials' : undefined} />;
  },
};

export interface MessagePartsProps {
  message: ChatUIMessage;
  pending?: boolean;
  onToolApproval?(approvalId: string, approved: boolean): Promise<void>;
  answeredApprovals?: ReadonlySet<string>;
  onAnswerQuestion?(questionId: string, answer: string): Promise<void>;
  onOpenAsset?(artifactId: string): void;
  onConfirmPreference?(proposal: PreferenceProposal): Promise<void> | void;
}

/** 按消息 part 的类型渲染文本、推理、工具活动、附件、资产和偏好建议。 */
export function MessageParts({
  message,
  pending = false,
  onToolApproval,
  answeredApprovals,
  onAnswerQuestion,
  onOpenAsset,
  onConfirmPreference,
}: MessagePartsProps) {
  const [proposalError, setProposalError] = useState<string | null>(null);
  const waitingForAnswer = message.parts.some(part =>
    part.type === 'data-tool-call-suspended' && !message.parts.some(item =>
      'toolCallId' in item && item.toolCallId === part.data.toolCallId && 'state' in item && item.state === 'output-available'));
  const waitingForApproval = message.parts.some(part =>
    (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'state' in part && part.state === 'approval-requested');

  // 偏好建议必须由用户点击确认后才保存；失败时保留提示供用户重试。
  async function confirm(proposal: PreferenceProposal) {
    if (!onConfirmPreference) {
      return;
    }
    try {
      await onConfirmPreference(proposal);
      setProposalError(null);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '偏好保存失败。');
    }
  }

  return (
    <div className={`message-parts message-parts--${message.role}`}>
      {message.metadata?.persistedStatus === 'error' && (
        <p className="message-parts__failure" role="status">上次生成未完成，可重试。</p>
      )}
      {message.parts.map((part, index) => {
        if (part.type === 'data-tool-call-suspended' && part.data.toolName === 'ask-user') {
          // 问题本身保存在暂停事件里；答案在恢复后同一个 toolCallId 的工具输出里。
          // 用 toolCallId 对齐这两种 part，历史重载时也能显示“已回答”。
          const data = part.data;
          const tool = message.parts.find(item =>
            (item.type === 'dynamic-tool' || item.type.startsWith('tool-')) && 'toolCallId' in item && item.toolCallId === data.toolCallId);
          const output = tool && 'output' in tool ? tool.output as { answer?: string } : undefined;
          // 父组件的回调只负责 HTTP 提交；生成结果继续从原聊天流更新 message.parts。
          return <UserQuestion key={data.runId + data.toolCallId} question={data.suspendPayload}
            active={pending && Boolean(onAnswerQuestion)} answered={output?.answer}
            onAnswer={answer => onAnswerQuestion!(data.runId + '::' + data.toolCallId, answer)} />;
        }
        if (part.type === 'text') {
          // Markdown 只渲染为 React 元素，不启用原始 HTML。
          // 未闭合的流式代码围栏也会被当作代码块，后续分片到达时自动更新。
          return (
            <div className="message-parts__text" key={index}>
              <ReactMarkdown components={markdownComponents}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        // useChat 已经把原生工具事件合并为一个带 state 的工具 part。
        if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
          const tool = part as { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown; errorText?: string; approval?: { id: string } };
          if ((tool.toolName ?? tool.type.slice(5)) === 'ask-user') return null;
          const approvalId = tool.state === 'approval-requested' ? tool.approval?.id : undefined;
          return <div className="message-parts__tool" key={index}>
            <details open={Boolean(approvalId)}>
            <summary>{tool.toolName ?? tool.type.slice(5)} · {tool.state}</summary>
            <pre>{JSON.stringify(tool.input, null, 2)}</pre>
            <pre>{tool.errorText ?? JSON.stringify(tool.output, null, 2)}</pre>
            </details>
            {approvalId && <div className="message-parts__approval">
              <span>{answeredApprovals?.has(approvalId) ? '已提交决定，等待 Agent 继续…' : pending ? '等待你确认本次工具调用' : '本次工具确认已结束'}</span>
              <button type="button" disabled={!pending || answeredApprovals?.has(approvalId)} onClick={() => void onToolApproval?.(approvalId, true)}>允许执行</button>
              <button type="button" disabled={!pending || answeredApprovals?.has(approvalId)} onClick={() => void onToolApproval?.(approvalId, false)}>拒绝执行</button>
            </div>}
          </div>;
        }
        if (part.type === 'file' || part.type === 'data-attachment') {
          const nativeFile = part.type === 'file';
          const url = nativeFile ? part.url : part.data.url;
          const name = nativeFile ? part.filename : part.data.fileName;
          const mediaType = nativeFile ? part.mediaType : part.data.mediaType;
          if (url && mediaType.startsWith('image/')) {
            const isApiImage = URL.parse(url, document.baseURI)?.origin === apiOrigin;
            return (
              <figure className="message-parts__image" key={index}>
                <img src={url} alt={name ?? '图片'} crossOrigin={isApiImage ? 'use-credentials' : undefined} />
                {name && <figcaption>{name}</figcaption>}
              </figure>
            );
          }
          if (nativeFile) return <a key={index} href={url}>{name ?? '附件'}</a>;
          return <div className="message-parts__attachment" key={index}>
            <span aria-hidden="true">▧</span><span>{name}</span><small>{mediaType}</small>
          </div>;
        }
        if (part.type === 'reasoning') {
          return (
            <details className="message-parts__reasoning" key={`reasoning-${index}`}>
              <summary>推理过程</summary>
              <p>{part.text}</p>
            </details>
          );
        }
        if (part.type === 'data-activity') {
          const activity = part.data;
          const stateLabel = {
            'input-streaming': '正在准备',
            'input-available': '已调用',
            'output-available': '已完成',
            error: '执行失败',
          }[activity.state];
          return (
            <div className="message-parts__activity" key={part.id ?? `activity-${index}`}>
              <span className="activity-indicator" aria-hidden="true" />
              <span>{activity.toolName}</span>
              <span>{stateLabel}</span>
            </div>
          );
        }
        if (part.type === 'data-asset') {
          return (
            <article className="message-parts__asset" key={part.id ?? `asset-${index}`}>
              <div>
                <span className="message-parts__asset-label">{readThreeModel(part.data.script) ? 'THREE.JS' : 'BLENDER ' + part.data.blenderVersion}</span>
                <h3>{part.data.brief}</h3>
                <p>{part.data.status === 'pending' ? '等待审阅' : part.data.status === 'approved' ? '已批准' : '已拒绝'}</p>
              </div>
              <button
                type="button"
                onClick={() => onOpenAsset?.(part.data.id)}
                aria-label={`审阅资产：${part.data.brief}`}
              >
                审阅资产
              </button>
            </article>
          );
        }
        if (part.type === 'data-preference') {
          const proposal = part.data;
          return (
            <aside className="message-parts__proposal" key={`proposal-${index}`}>
              <div>
                <strong>偏好建议：{proposal.key}</strong>
                <p>{proposal.value}</p>
                <small>{proposal.reason}</small>
              </div>
              <button
                type="button"
                onClick={() => void confirm(proposal)}
                disabled={!onConfirmPreference}
                aria-label={`保存偏好：${proposal.key}`}
              >
                确认保存
              </button>
            </aside>
          );
        }
        return null;
      })}
      {pending && <p className="message-parts__loading" role="status"><span className="loading-dot" aria-hidden="true" />{waitingForAnswer ? '等待你回答…' : waitingForApproval ? '等待工具确认…' : '正在生成回复…'}</p>}
      {proposalError && <p className="inline-error" role="alert">{proposalError}</p>}
    </div>
  );
}
