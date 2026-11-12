import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  MAX_ATTACHMENT_BYTES,
  supportedMediaTypes,
  type UploadMetadata,
} from '@agent3d/shared';

export interface ComposerProps {
  onUpload(file: File): Promise<UploadMetadata>;
  onSubmit(text: string, attachments: UploadMetadata[]): Promise<void> | void;
  disabled: boolean;
  modelId: string | null;
  hasApiKey: boolean;
  onOpenModelSettings(): void;
  modelError?: string | null;
}

/** 消息输入区：先上传附件，再把附件信息和文本一起提交给聊天组件。 */
export function Composer({ onUpload, onSubmit, disabled, modelId, hasApiKey, onOpenModelSettings, modelError }: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<UploadMetadata[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 前端先检查类型和大小，服务端还会独立校验文件内容，不能只依赖前端检查。
  async function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = ''; // 清空 input，让用户再次选择同一个文件时仍能触发 change。
    setError(null);
    for (const file of files) {
      if (!supportedMediaTypes.includes(file.type as (typeof supportedMediaTypes)[number])) {
        setError('仅支持 PNG、JPEG、WebP、PDF、Markdown 或纯文本文件。');
        continue;
      }
      if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
        setError(`文件大小需在 1 至 ${MAX_ATTACHMENT_BYTES} 字节之间。`);
        continue;
      }

      setUploading(true);
      try {
        const uploaded = await onUpload(file);
        setAttachments((current) => [...current, uploaded]);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : '文件上传失败。');
      } finally {
        setUploading(false);
      }
    }
  }

  // 上传期间或内容为空时不发送；onSubmit 正常返回后清空输入，抛错时保留内容。
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !hasApiKey || uploading || (!text.trim() && attachments.length === 0)) {
      return;
    }
    try {
      await onSubmit(text.trim(), attachments);
      setText('');
      setAttachments([]);
      setError(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '消息发送失败。');
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      {attachments.length > 0 && (
        <ul className="composer__attachments" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span>{attachment.fileName}</span>
              <small>{Math.ceil(attachment.size / 1024)} KB</small>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {modelError && <p className="inline-error" role="alert">{modelError}</p>}
      {uploading && <p className="composer__upload-status" role="status">正在上传附件…</p>}
      <label className="visually-hidden" htmlFor="chat-prompt">写下你的想法</label>
      <textarea
        id="chat-prompt"
        aria-label="写下你的想法"
        placeholder="描述你想创造的 3D 资产…"
        maxLength={8000}
        rows={3}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer__toolbar">
        <button
          type="button"
          className={`composer__model${hasApiKey ? '' : ' composer__model--missing'}`}
          onClick={onOpenModelSettings}
        >
          {modelId ?? '正在读取模型…'}
        </button>
        {modelId && !hasApiKey && <span className="composer__model-notice">请在模型设置中填写 API Key</span>}
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept={supportedMediaTypes.join(',')}
          aria-label="添加图片或文档"
          multiple
          disabled={disabled || uploading}
          onChange={(event) => void selectFiles(event)}
        />
        <button
          type="button"
          className="composer__attach"
          aria-label="选择文件"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          ＋ 添加图片或文档
        </button>
        <span className="composer__hint">Enter 发送 · Shift+Enter 换行</span>
        <button
          type="submit"
          className="composer__send"
          disabled={disabled || !hasApiKey || uploading || (!text.trim() && attachments.length === 0)}
          aria-label="发送"
        >
          发送 <span aria-hidden="true">↑</span>
        </button>
      </div>
    </form>
  );
}
