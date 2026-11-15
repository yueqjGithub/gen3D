import { describe, it, expect } from 'vitest';
import { readThreeModel } from './three-model';
describe('script model manifest', () => {
  it('keeps the source and a file identifier without embedding binary data', () => {
    const model = { format: 'three-script-v1', source: 'return new THREE.Group();', modelId: '0a000000-0000-4000-8000-000000000001' };
    expect(readThreeModel(JSON.stringify(model))).toEqual(model);
  });
  it('rejects file paths and invalid manifests', () => {
    expect(readThreeModel(JSON.stringify({ format: 'three-script-v1', source: 'return 1;', modelId: '../../secret' }))).toBe(null);
    expect(readThreeModel('not json')).toBe(null);
  });
});
