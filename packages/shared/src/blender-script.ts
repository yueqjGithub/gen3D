/** Static validation failures returned for untrusted generated Blender scripts. */
export type ScriptValidationCode =
  | 'empty'
  | 'too_large'
  | 'missing_bpy'
  | 'blocked_pattern';

/** Result of checking a script as text; validation never executes Python code. */
export type ScriptValidationResult =
  | { ok: true }
  | { ok: false; code: ScriptValidationCode };

const maxScriptBytes = 100 * 1024;
const blenderImportPattern = /(?:^|\n)\s*(?:import\s+bpy(?:\s+as\s+\w+)?|from\s+bpy\s+import\b)/m;

const blockedPatterns = [
  /\bexec\s*\(/i,
  /\beval\s*\(/i,
  /\bsubprocess\b/i,
  /\bos\s*\.\s*system\s*\(/i,
  /\b__import__\s*\(/i,
];

/**
 * Checks size, Blender imports, and dangerous execution patterns without running the script.
 */
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
