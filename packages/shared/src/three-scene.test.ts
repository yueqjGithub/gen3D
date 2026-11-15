import { describe, it, expect } from 'vitest';
import { readThreeScene, validateAssetScript } from './three-scene';
const scene = { format: 'three-primitives-v1', objects: [{ name: 'body', geometry: 'sphere', color: '#ffffff', position: [0,1,0], rotation: [0,0,0], scale: [1,1,1] }] };
describe('Three.js asset data', () => {
  it('accepts scene data and keeps legacy Blender support', () => {
    expect(readThreeScene(JSON.stringify(scene))).toEqual(scene);
    expect(validateAssetScript(JSON.stringify(scene)).ok).toBe(true);
    expect(validateAssetScript('import bpy').ok).toBe(true);
  });
  it('rejects invalid geometry, excessive scale, and executable content', () => {
    expect(readThreeScene(JSON.stringify({ ...scene, objects: [{ ...scene.objects[0], geometry: 'script' }] }))).toBe(null);
    expect(readThreeScene(JSON.stringify({ ...scene, objects: [{ ...scene.objects[0], scale: [1,10000,1] }] }))).toBe(null);
    expect(validateAssetScript('<script>alert(1)</script>').ok).toBe(false);
  });
});
