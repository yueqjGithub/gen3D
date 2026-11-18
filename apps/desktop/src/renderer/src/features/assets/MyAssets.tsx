import { useEffect, useRef, useState } from 'react';
import { readThreeModel, type AssetArtifact } from '@agent3d/shared';
import { api } from '../../api/client';
import { ModelPreview } from './ModelPreview';

/**
 * “我的资产”读取已有 approved 记录，不另存一份资产，也不重新执行建模脚本。
 * 弹窗保留底下的聊天组件，查看资产不会因为切换页面而中断正在接收的 SSE。
 */
export function MyAssets({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<AssetArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal(); // 原生 dialog 提供焦点范围、Escape 关闭和关闭后的焦点恢复。
    return () => element.close();
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void api.listApprovedAssets().then(items => { if (active) setAssets(items); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '无法读取资产'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  const filtered = assets.filter(asset => asset.brief.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = filtered.find(asset => asset.id === selectedId) ?? filtered[0];
  const model = selected && readThreeModel(selected.script);

  async function download() {
    if (!selected || downloading) return;
    setDownloading(true); setDownloadError('');
    try {
      // 下载仍由服务端核验用户归属与批准状态，界面不会直接拿到 Storage 密钥。
      const blob = await api.downloadArtifact(selected.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `asset-${selected.id}-v${selected.version}.${model ? 'glb' : 'py'}`;
      anchor.click(); URL.revokeObjectURL(url);
    } catch (failure) {
      setDownloadError(failure instanceof Error ? failure.message : '下载失败，请重试');
    } finally { setDownloading(false); }
  }

  return <dialog className="my-assets" ref={dialog} aria-labelledby="my-assets-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="my-assets__header">
      <div><span className="my-assets__eyebrow">个人空间</span><h2 id="my-assets-title">我的资产 <small>{assets.length}</small></h2><p>已批准的模型，可随时预览和下载。</p></div>
      <button type="button" className="my-assets__close" aria-label="关闭我的资产" onClick={onClose}>×</button>
    </header>
    <div className="my-assets__toolbar">
      <label className="visually-hidden" htmlFor="asset-search">搜索我的资产</label>
      <input id="asset-search" type="search" value={query} placeholder="搜索已批准的资产…" onChange={event => { setQuery(event.target.value); setDownloadError(''); }} />
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button>
    </div>
    {loading ? <p className="my-assets__empty" role="status">正在读取你的资产…</p>
      : error ? <div className="my-assets__empty" role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>
      : !filtered.length ? <div className="my-assets__empty">
        <span aria-hidden="true">◇</span><h3>{query ? '没有找到匹配的资产' : '还没有已批准的资产'}</h3>
        <p>{query ? '试试其他关键词。' : '在聊天中批准模型后，就可以在这里预览和下载。'}</p>
      </div>
      : <div className="my-assets__body">
        <div className="my-assets__list" role="group" aria-label="已批准的资产">
          {filtered.map(asset => <button type="button" key={asset.id} className="my-assets__item" aria-pressed={asset.id === selected?.id}
            onClick={() => { setSelectedId(asset.id); setDownloadError(''); }}>
            <span className="my-assets__item-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="m16 3 12 7v13l-12 7-12-7V10Zm0 13 12-6M16 16 4 10m12 6v14" /></svg></span>
            <strong>{asset.brief}</strong><span>版本 {asset.version} · {new Date(asset.createdAt).toLocaleDateString('zh-CN')}</span>
          </button>)}
        </div>
        {selected && <section className="my-assets__detail" aria-label="资产详情">
          <span className="my-assets__approved">已批准</span><h3>{selected.brief}</h3>
          {/* 一次只创建一个 WebGL 预览；approved 状态只读取保存的 GLB，不重新构建。 */}
          {model ? <ModelPreview key={selected.id} artifactId={selected.id} version={selected.version} source={model.source} status="approved" onReady={() => {}} />
            : <p>此资产可下载脚本后查看。</p>}
          <div className="my-assets__download"><span>版本 {selected.version}<small>{new Date(selected.createdAt).toLocaleString('zh-CN')}</small></span>
            <button type="button" onClick={() => void download()} disabled={downloading}>{downloading ? '正在下载…' : model ? '下载 GLB' : '下载脚本'} <span aria-hidden="true">↓</span></button>
          </div>
          {downloadError && <p className="inline-error" role="alert">{downloadError}</p>}
        </section>}
      </div>}
    <footer className="my-assets__footer">资产随原会话保存；删除会话时，这里的资产也会一同删除。</footer>
  </dialog>;
}
