import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';

/** 登录和修改密码共用表单：修改密码时必须输入旧密码。 */
export function LoginForm({ username: initialUsername, onLogin, onClose }: {
  username?: string;
  onLogin?(username: string): void;
  onClose?(): void;
}) {
  const [username, setUsername] = useState(initialUsername ?? '');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changing, setChanging] = useState(Boolean(initialUsername));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (changing) {
        await api.changePassword(username, password, newPassword);
        setPassword('');
        setNewPassword('');
        setMessage('密码已修改。');
      } else {
        onLogin?.(await api.login(username, password));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login-card" aria-label={changing ? '修改密码' : '登录'}>
      <h1>{changing ? '修改密码' : '登录 3D 资产工作台'}</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} required disabled={Boolean(initialUsername)} /></label>
        <label>{changing ? '旧密码' : '密码'}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {changing && <label>新密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>}
        {message && <p role="status">{message}</p>}
        <button className="primary-button" disabled={busy} type="submit">{changing ? '保存密码' : '登录 / 创建用户'}</button>
      </form>
      {!initialUsername && <button type="button" onClick={() => { setChanging(!changing); setMessage(null); }}>{changing ? '返回登录' : '修改密码'}</button>}
      {onClose && <button type="button" onClick={onClose}>关闭</button>}
    </section>
  );
}
