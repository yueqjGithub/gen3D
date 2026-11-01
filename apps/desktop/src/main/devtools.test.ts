import { describe, expect, it, vi } from 'vitest';
import { createApplicationMenuTemplate } from './devtools';

describe('developer tools menu', () => {
  it('addsAnF12DeveloperToolsEntryOnlyInDevelopment', () => {
    const toggleDevTools = vi.fn();
    const template = createApplicationMenuTemplate(false, toggleDevTools);

    expect(template).toEqual([{
      label: '查看',
      submenu: [{
        label: '开发者工具',
        accelerator: 'F12',
        click: toggleDevTools,
      }],
    }]);
    expect(createApplicationMenuTemplate(true, toggleDevTools)).toBeNull();
  });
});
