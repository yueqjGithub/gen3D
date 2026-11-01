export type ScriptValidationCode =
  | 'empty'
  | 'too_large'
  | 'missing_bpy'
  | 'blocked_pattern';

export type ScriptValidationResult =
  | { ok: true }
  | { ok: false; code: ScriptValidationCode };

const maxScriptBytes = 100 * 1024;
const blenderImportPattern = /(?:^|\n)\s*(?:import\s+bpy(?:\s+as\s+\w+)?|from\s+bpy\s+import\b)/m;

// Generated code is reviewed as text only; this deliberately never invokes Python or Blender.
const blockedPatterns = [
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bsubprocess\b/i,
  /\bos\s*\.\s*system\s*\(/i,
  /\b__import__\s*\(/i,
];

export function validateBlenderScript(script: string): ScriptValidationResult {
  if (!script.trim()) {
    return { ok: false, code: 'empty' };
  }
  if (Buffer.byteLength(script, 'utf8') > maxScriptBytes) {
    return { ok: false, code: 'too_large' };
  }
  if (!blenderImportPattern.test(script)) {
    return { ok: false, code: 'missing_bpy' };
  }
  if (blockedPatterns.some((pattern) => pattern.test(script))) {
    return { ok: false, code: 'blocked_pattern' };
  }
  return { ok: true };
}
