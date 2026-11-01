import { useEffect, useState } from 'react';
import type { AssetArtifact } from '@agent3d/shared';
import type { ApiClient } from '../../api/client';
import type { ScriptValidation } from '../../api/types';

export interface AssetPanelProps {
  api: ApiClient;
  artifact: AssetArtifact;
  onChange(artifact: AssetArtifact): void;
}

export function AssetPanel({ api, artifact, onChange }: AssetPanelProps) {
  const [script, setScript] = useState(artifact.script);
  const [validation, setValidation] = useState<ScriptValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [api, artifact.id, artifact.version]);

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
      anchor.download = `asset-${artifact.id}-v${artifact.version}.py`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '资产下载失败。');
    } finally {
      setBusy(false);
    }
  }

  const hasChanges = script !== artifact.script;
  const canApprove = artifact.status === 'pending' && !hasChanges && validation?.ok === true;

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
        <span>BLENDER {artifact.blenderVersion}</span>
        <h3>{artifact.brief}</h3>
        <p>版本 {artifact.version} · 编辑后需重新批准</p>
      </section>

      <div className="asset-panel__editor">
        <label htmlFor="asset-script">Blender Python 脚本</label>
        <textarea
          id="asset-script"
          aria-label="Blender Python 脚本"
          spellCheck={false}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          disabled={artifact.status !== 'pending' || busy}
        />
      </div>

      <div className="asset-panel__validation" role="status">
        {validation === null
          ? '正在检查脚本…'
          : validation.ok
            ? '静态脚本检查通过'
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
          下载 .py
        </button>
      </div>
      <p className="asset-panel__disclaimer">
        脚本仅做静态检查，不会在应用内执行。请在 Blender 中审阅后再运行。
      </p>
    </aside>
  );
}
