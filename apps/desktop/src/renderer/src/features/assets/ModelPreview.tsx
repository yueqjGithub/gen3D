import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import frameHTML from '../../../../../generated/model-preview.html?raw';

interface Props {
  artifactId: string;
  version: number;
  source: string;
  status: 'pending' | 'approved' | 'rejected';
  onReady(ready: boolean): void;
}

/**
 * 首先读取已保存的 GLB。仅文件尚未生成且资产待审阅时才执行源码。
 * sandbox 不授予 same-origin、Node 或下载权限；下载和上传由主页面负责。
 * iframe 只拿到源码或二进制，不拿到 API Key、Cookie 或任何存储凭据。
 */
export function ModelPreview({ artifactId, version, source, status, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('正在读取模型…');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  useEffect(() => {
    let active = true, started = false;
    const abort = new AbortController();
    const channel = new MessageChannel();
    const frame = document.createElement('iframe');
    frame.title = '隔离的 3D 模型预览'; frame.sandbox.add('allow-scripts');
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
    frame.referrerPolicy = 'no-referrer';
    onReadyRef.current(false); setError(''); setMessage('正在读取已保存的 GLB…');
    const timer = setTimeout(() => {
      if (active) { setError('客户端构建或上传耗时过长，可重试或简化模型。'); frame.remove(); }
    }, 60000);
    channel.port1.onmessage = async event => {
      if (!active) return;
      try {
        if (event.data?.type === 'error') throw Error(String(event.data.message).slice(0, 2000));
        if (event.data?.type === 'generated') {
          const bytes = event.data.bytes;
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 20 * 1024 * 1024) throw Error('GLB 超过 20 MiB 限制。');
          setMessage('GLB 已导出，正在保存到 Supabase…');
          await api.saveModel(artifactId, version, bytes);
          // 保存后加载服务端的实际文件，多窗口并发构建时也显示最终保存的同一份 GLB。
          if (active) { clearTimeout(timer); setAttempt(value => value + 1); }
          return;
        } else if (event.data?.type !== 'ready') return;
        if (!active) return;
        clearTimeout(timer); onReadyRef.current(true);
        setMessage('已保存 · 拖动旋转 · 滚轮缩放 · 右键平移');
      } catch (failure) {
        if (active) { clearTimeout(timer); setError(failure instanceof Error ? failure.message : '模型保存失败'); }
      }
    };
    frame.onload = async () => {
      // 只初始化固定 srcdoc 一次，不能在生成脚本自行导航后再次发送源代码或端口。
      if (!active || started) return; started = true;
      // sandbox 的不透明 origin 不能写成站点 origin。目标仍精确指定 contentWindow，
      // '*' 不用于广播；返回数据只经本次转移的 MessageChannel 接收。
      try {
        const response = await fetch(api.baseUrl + '/api/artifacts/' + encodeURIComponent(artifactId) + '/model', { credentials: 'include', signal: abort.signal });
        if (!active) return;
        if (response.ok) {
          const bytes = await response.arrayBuffer();
          if (active) frame.contentWindow!.postMessage({ type: 'initialize-model', bytes }, '*', [channel.port2, bytes]);
        } else if (response.status === 404 && status === 'pending') {
          setMessage('正在客户端执行脚本并导出 GLB…');
          frame.contentWindow!.postMessage({ type: 'initialize-model', source }, '*', [channel.port2]);
        } else throw Error('无法读取模型（HTTP ' + response.status + '）。');
      } catch (failure) {
        if (active) { clearTimeout(timer); setError(failure instanceof Error ? failure.message : '无法构建模型'); }
      }
    };
    frame.srcdoc = frameHTML; host.current!.appendChild(frame);
    return () => { active = false; abort.abort(); clearTimeout(timer); channel.port1.close(); channel.port2.close(); frame.remove(); };
  }, [artifactId, version, source, status, attempt]);
  return <section aria-label="3D 模型预览">
    <div className="model-preview" ref={host} />
    {error ? <div><p role="alert">{error}</p><p>可将错误发给 Agent，要求修正完整脚本。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试构建或加载</button></div> : <p role="status">{message}</p>}
  </section>;
}
