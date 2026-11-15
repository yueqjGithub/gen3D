import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MAX_ATTACHMENT_BYTES,
  supportedMediaTypes,
  type UploadMetadata,
} from '@agent3d/shared';

export interface ComposerProps {
  onUpload(file: File): Promise<UploadMetadata>;
  onSubmit(text: string, attachments: UploadMetadata[]): Promise<void> | void;
  generating: boolean;
  onStop(): void;
  modelId: string | null;
  hasApiKey: boolean;
  onOpenModelSettings(): void;
  modelError?: string | null;
}

// Windows 拖入的文件（尤其是 .md）可能缺少 MIME 类型。仅在系统未识别时用扩展名补全，
// 服务端仍会检查实际文件内容。选择、拖入和粘贴都使用相同的白名单。
const mediaByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
};

interface DraftAttachment {
  id: string;
  file: File;
  uploaded?: UploadMetadata;
}

/** 缩略图直接读取选中的文件。移除、发送或切换会话后释放浏览器持有的文件引用。 */
function DraftImage({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return url ? <img src={url} alt={file.name} /> : null;
}

/** 附件先留在本地草稿，点发送时才上传，因此挑错图片可以直接移除。 */
export function Composer({ onUpload, onSubmit, generating, onStop, modelId, hasApiKey, onOpenModelSettings, modelError }: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [dragDepth, setDragDepth] = useState(0);

  // 前端先检查类型和大小，服务端还会独立校验文件内容，不能只依赖前端检查。
  function addFiles(files: File[]) {
    if (generating || submitting.current || !files.length) return;
    setError(null);
    const added: DraftAttachment[] = [];
    for (let file of files) {
      if (!file.type || file.type === 'application/octet-stream') {
        const type = mediaByExtension[/\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ''];
        if (type) file = new File([file], file.name, { type, lastModified: file.lastModified });
      }
      if (!(supportedMediaTypes as readonly string[]).includes(file.type)) {
        setError(`「${file.name}」格式不受支持。可添加 PNG、JPEG、WebP、PDF、Markdown 或纯文本文件。`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
        setError(`「${file.name}」必须是非空文件，且不能超过 10 MB。`);
        continue;
      }
      added.push({ id: crypto.randomUUID(), file });
    }
    setAttachments(current => [...current, ...added]);
  }

  // 上传期间或内容为空时不发送；onSubmit 正常返回后清空输入，抛错时保留内容。
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating || !hasApiKey || submitting.current || (!text.trim() && attachments.length === 0)) {
      return;
    }
    submitting.current = true;
    try {
      const ready: UploadMetadata[] = [];
      setUploading(attachments.some(item => !item.uploaded));
      for (const item of attachments) {
        if (!mounted.current) return;
        // 部分上传失败时保留草稿。重试复用先前成功的 ID，避免重复占用会话配额。
        const uploaded = item.uploaded ?? await onUpload(item.file);
        if (!mounted.current) return;
        if (!item.uploaded) setAttachments(current => current.map(draft => draft.id === item.id ? { ...draft, uploaded } : draft));
        ready.push(uploaded);
      }
      setUploading(false);
      await onSubmit(text.trim(), ready);
      setText('');
      setAttachments([]);
      setError(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '消息发送失败。');
    } finally {
      setUploading(false);
      submitting.current = false;
    }
  }

  return (
    <form
      className={dragDepth > 0 && !generating ? 'composer composer--dragging' : 'composer'}
      onSubmit={(event) => void submit(event)}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDragDepth(depth => depth + 1);
      }}
      onDragLeave={() => setDragDepth(depth => Math.max(0, depth - 1))}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        // dragover 期间系统尚未开放文件内容；取消默认行为后，松手才会触发 drop。
        event.preventDefault();
        event.dataTransfer.dropEffect = generating ? 'none' : 'copy';
      }}
      onDrop={(event) => {
        setDragDepth(0);
        if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.files.length) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const clipboard = event.clipboardData;
        // 截图可能只出现在 items 中。优先读取 files，避免同一张图片被上传两次。
        const files = Array.from(clipboard.files);
        if (!files.length) {
          for (const item of clipboard.items) {
            const file = item.kind === 'file' ? item.getAsFile() : null;
            if (file) files.push(file);
          }
        }
        if (!files.length) return; // 纯文本交给 textarea，保留光标位置和原生撤销行为。
        event.preventDefault();
        addFiles(files);
      }}
    >
      {!generating && attachments.length > 0 && (
        <ul className="composer__attachments" aria-label="待发送附件">
          {attachments.map(({ id, file }) => (
            <li key={id}>
              {file.type.startsWith('image/') && <DraftImage file={file} />}
              <span className="composer__filename" title={file.name}>{file.name}</span>
              <small>{Math.ceil(file.size / 1024)} KB</small>
              <button type="button" className="composer__remove" aria-label={`移除 ${file.name}`}
                disabled={uploading} onClick={() => setAttachments(current => current.filter(item => item.id !== id))}>×</button>
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
        disabled={generating || uploading}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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
          accept={[...supportedMediaTypes, '.md', '.markdown'].join(',')}
          aria-label="添加图片或文档"
          multiple
          disabled={generating || uploading}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = ''; // 再次选择同名文件也能触发 change。
            addFiles(files);
          }}
        />
        <button
          type="button"
          className="composer__attach"
          aria-label="选择文件"
          title="选择、拖入或粘贴图片和文档"
          disabled={generating || uploading}
          onClick={() => inputRef.current?.click()}
        >
          ＋ 添加图片或文档
        </button>
        <span className="composer__hint">Enter 发送 · Shift+Enter 换行</span>
        <button
          type={generating ? 'button' : 'submit'}
          className="composer__send"
          disabled={!generating && (!hasApiKey || uploading || (!text.trim() && attachments.length === 0))}
          onClick={generating ? (event) => { event.preventDefault(); onStop(); } : undefined}
          aria-label={generating ? '停止生成' : '发送'}
          title={generating ? '停止生成' : '发送'}
        >
          {generating ? <span className="composer__stop-icon" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
        </button>
      </div>
    </form>
  );
}
