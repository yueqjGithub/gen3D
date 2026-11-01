import type { MenuItemConstructorOptions } from 'electron';

export function createApplicationMenuTemplate(
  isPackaged: boolean,
  toggleDevTools: () => void,
): MenuItemConstructorOptions[] | null {
  if (isPackaged) {
    return null;
  }

  return [{
    label: '查看',
    submenu: [{
      label: '开发者工具',
      accelerator: 'F12',
      click: toggleDevTools,
    }],
  }];
}
