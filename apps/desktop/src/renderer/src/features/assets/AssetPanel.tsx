import { useMemo } from 'react';
import { readThreeModel } from '@agent3d/shared';
import { ModelPreview } from './ModelPreview';
import { useEffect, useState } from 'react';
import type { AssetArtifact } from '@agent3d/shared';
import { api } from '../../api/client';
import type { ScriptValidation } from '../../api/types';

export interface AssetPanelProps {
  artifact: AssetArtifact;
  onChange(artifact: AssetArtifact): void;
}

/** 源码在隔离 iframe 中执行，导出的 GLB 上传成功后才允许批准下载。 */
export function AssetPanel({ artifact, onChange }: AssetPanelProps) {
  const model = useMemo(() => readThreeModel(artifact.script), [artifact.script]);
  const [script, setScript] = useState(artifact.script);
  const [validation, setValidation] = useState<ScriptValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 资产或版本变化时重新读取服务端校验结果，忽略旧请求的迟到响应。
  useEffect(() => {
    let active = true;
    setScript(artifact.script);
    setValidation(null);
    setError(null);
    void api.getArtifact(artifact.id)
      .then(({ scriptValidation }) => {
        if (active) {
          setValidation(scriptValidation);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : '无法读取脚本检查结果。');
        }
      });
    return () => {
      active = false;
    };
  }, [artifact.id, artifact.version]);

  // 提交当前版本号；服务端用它检测并发修改，避免覆盖较新的脚本。
  async function saveScript() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateArtifact(artifact.id, artifact.version, script);
      setScript(result.artifact.script);
      setValidation(result.scriptValidation);
      onChange(result.artifact);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '脚本保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(action: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const updated = action === 'approve'
        ? await api.approveArtifact(artifact.id, artifact.version)
        : await api.rejectArtifact(artifact.id, artifact.version);
      onChange(updated);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : '资产状态更新失败。');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.downloadArtifact(artifact.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `asset-${artifact.id}-v${artifact.version}.${model ? 'glb' : 'py'}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '资产下载失败。');
    } finally {
      setBusy(false);
    }
  }

  // 必须先保存修改并通过静态检查，才能批准；只有批准后的脚本可以下载。
  const hasChanges = script !== artifact.script;
  const canApprove = artifact.status === 'pending' && !hasChanges && validation?.ok === true && (!model || modelReady);

  return (
    <aside className="asset-panel" aria-label="资产审阅">
      <header className="asset-panel__header">
        <div>
          <span className="asset-panel__eyebrow">生成的资产</span>
          <h2>资产审阅</h2>
        </div>
        <span className={`asset-status asset-status--${artifact.status}`}>
          {artifact.status === 'pending' ? '待审阅' : artifact.status === 'approved' ? '已批准' : '已拒绝'}
        </span>
      </header>

      <section className="asset-panel__summary">
        <span>{model ? 'THREE.JS' : 'BLENDER ' + artifact.blenderVersion}</span>
        <h3>{artifact.brief}</h3>
        <p>版本 {artifact.version} · 编辑后需重新批准</p>
      </section>

      {model && <ModelPreview key={artifact.id} artifactId={artifact.id} version={artifact.version} source={model.source} status={artifact.status} onReady={setModelReady} />}
      <details open={!model}>
        <summary>{model ? '查看建模脚本' : '查看或编辑脚本'}</summary>
      <div className="asset-panel__editor">
        <label htmlFor="asset-script">{model ? 'Three.js 建模脚本' : '脚本'}</label>
        <textarea
          id="asset-script"
          aria-label={model ? 'Three.js 建模脚本' : 'Blender Python 脚本'}
          spellCheck={false}
          value={model ? model.source : script}
          onChange={(event) => setScript(event.target.value)}
          disabled={Boolean(model) || artifact.status !== 'pending' || busy}
        />
      </div>

      </details>
      <div className="asset-panel__validation" role="status">
        {validation === null
          ? '正在检查脚本…'
          : validation.ok
            ? (model ? '场景数据检查通过' : '静态脚本检查通过')
            : `需要修正脚本：${validation.code ?? '检查失败'}`}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}

      <div className="asset-panel__actions">
        <button
          type="button"
          onClick={() => void saveScript()}
          disabled={busy || artifact.status !== 'pending' || !hasChanges}
        >
          保存脚本
        </button>
        <button
          type="button"
          onClick={() => void changeStatus('reject')}
          disabled={busy || artifact.status !== 'pending'}
        >
          拒绝
        </button>
        <button
          type="button"
          className="asset-panel__approve"
          onClick={() => void changeStatus('approve')}
          disabled={busy || !canApprove}
        >
          批准资产
        </button>
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy || artifact.status !== 'approved'}
        >
          下载 {model ? '.glb' : '.py'}
        </button>
      </div>
      <p className="asset-panel__disclaimer">
        {model ? '脚本由客户端隔离执行；GLB 保存后可跨设备查看。修改模型请在聊天中提出要求。' : '脚本仅做静态检查，请在 Blender 中审阅后再运行。'}
      </p>
    </aside>
  );
}
