import { useEffect, useRef, useState } from 'react';

/** 账户相关入口集中在这里；页面与弹窗的显示状态仍由 App 管理。 */
export function AccountMenu({ username, onAssets, onPassword, onSettings }: {
  username: string;
  onAssets(): void;
  onPassword(): void;
  onSettings(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function select(action: () => void) {
    // 菜单项即将卸载；先把焦点交回常驻头像，让资产弹窗关闭后可以恢复到这里。
    setOpen(false); trigger.current?.focus(); action();
  }

  return <div className="account-menu" ref={root}>
    <button className="account-menu__trigger" ref={trigger} type="button" aria-label="账户菜单"
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="account-menu__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" />
        </svg>
      </span>
      <svg className="account-menu__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="account-menu__dropdown" role="menu" aria-label="账户操作" onKeyDown={event => {
      // 使用方向键也能选菜单，按 Escape 可回到头像按钮。
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div className="account-menu__identity" role="presentation"><strong>{username}</strong><span>个人空间</span></div>
      <button type="button" role="menuitem" onClick={() => select(onAssets)}><span aria-hidden="true">◇</span>我的资产</button>
      <button type="button" role="menuitem" onClick={() => select(onSettings)}><span aria-hidden="true">⚙</span>设置</button>
      <button type="button" role="menuitem" onClick={() => select(onPassword)}><span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.5 9.5M17 6l3 3m-6 0 3 3" /></svg></span>修改密码</button>
    </div>}
  </div>;
}
