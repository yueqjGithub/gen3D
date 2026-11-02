import { describe, expect, it } from 'vitest';
import { validateBlenderScript } from './index';

describe('Blender script validation', () => {
  it('rejectsEmptyOversizedAndNonBlenderScripts', () => {
    expect(validateBlenderScript('')).toEqual({ ok: false, code: 'empty' });
    expect(validateBlenderScript(`import bpy\n${'x'.repeat(100 * 1024)}`))
      .toEqual({ ok: false, code: 'too_large' });
    expect(validateBlenderScript('print("not a Blender script")'))
      .toEqual({ ok: false, code: 'missing_bpy' });
  });

  it('blocksDangerousExecutionPatterns', () => {
    for (const script of [
      'import bpy\nexec("print(1)")',
      'import bpy\neval("1 + 1")',
      'import bpy\nimport subprocess',
      'import bpy\nos.system("whoami")',
    ]) {
      expect(validateBlenderScript(script)).toEqual({
        ok: false,
        code: 'blocked_pattern',
      });
    }
  });
});
