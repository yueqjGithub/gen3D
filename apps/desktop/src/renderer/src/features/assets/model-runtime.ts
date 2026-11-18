import { dogModelSource } from './dog-model';

/** iframe 中使用的 Three.js 建模库。构建时打包，运行时没有 Node、密钥或网络权限。 */
export const modelRuntimeSource = `
    import * as THREE from './three.module.js';
    import { GLTFExporter } from '../examples/jsm/exporters/GLTFExporter.js';
    import { MarchingCubes } from '../examples/jsm/objects/MarchingCubes.js';
    import { RoundedBoxGeometry } from '../examples/jsm/geometries/RoundedBoxGeometry.js';
    import { TessellateModifier } from '../examples/jsm/modifiers/TessellateModifier.js';
    import { mergeVertices } from '../examples/jsm/utils/BufferGeometryUtils.js';

    // 沿一条连续曲线扫掠椭圆截面。与固定管径的 TubeGeometry 相比，尾巴、爪腕、
    // 叶柄等部件可以从根部逐渐收尖。相邻截面共享三角形，弯曲处不会脱节。
    function taper(points) {
      if (!Array.isArray(points) || points.length < 2 || points.length > 128 ||
          !points.every(p => Array.isArray(p) && p.length === 5 && p.every(Number.isFinite) && p[3] > 0 && p[4] > 0)) {
        throw new Error('taper expects 2..128 [x,y,z,radiusA,radiusB] points with positive radii.');
      }
      const path = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p.slice(0,3))));
      if (path.points.some((p,i) => i > 0 && p.equals(path.points[i-1]))) throw new Error('taper needs distinct neighboring centers.');
      const rings = Math.max(16, 8 * (points.length-1)), sides = 20;
      const frames = path.computeFrenetFrames(rings, false);
      // 第一个截面的第二根轴尽量朝 Z，后续截面使用曲线的平行移动标架，避免突然翻面。
      const depthAxis = Math.abs(frames.tangents[0].z) < 0.95 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(0,1,0);
      const rotation = Math.atan2(depthAxis.dot(frames.binormals[0]), depthAxis.dot(frames.normals[0])) - Math.PI/2;
      const vertices = [], indices = [];
      const v = new THREE.Vector3();
      for (let i = 0; i <= rings; i++) {
        const u = i/rings;
        const t = path.getUtoTmapping(u);
        const center = path.getPoint(t);
        const index = Math.min(Math.floor(t*(points.length-1)), points.length-2);
        const f = t*(points.length-1)-index;
        const a = THREE.MathUtils.lerp(points[index][3], points[index+1][3], f);
        const b = THREE.MathUtils.lerp(points[index][4], points[index+1][4], f);
        for (let j = 0; j < sides; j++) {
          const angle = j * 2*Math.PI/sides;
          const x = a*Math.cos(angle), y = b*Math.sin(angle);
          v.copy(center).addScaledVector(frames.normals[i], x*Math.cos(rotation)-y*Math.sin(rotation))
            .addScaledVector(frames.binormals[i], x*Math.sin(rotation)+y*Math.cos(rotation));
          vertices.push(v.x,v.y,v.z);
          if (i === rings) continue;
          const k = i*sides+j, next = i*sides+(j+1)%sides;
          indices.push(k,next,k+sides, next,next+sides,k+sides);
        }
      }
      // 用端面三角形封住两端，使导出的部件从任何方向观察都是完整的。
      for (let j = 1; j < sides-1; j++) {
        indices.push(0,j+1,j, rings*sides,rings*sides+j,rings*sides+j+1);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices,3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      return geometry;
    }

    // 每段描述一个体积 [中心x, 中心y, 中心z, 半径x, 半径y, 半径z]。
    // 先在空间里融合体积，再沿整块体积的外表面生成三角形，这样肩颈等交界处能连续过渡。
    function sculpt(parts, blend = 0.35, resolution = 48) {
      if (!Array.isArray(parts) || !parts.length || parts.length > 64 ||
          !parts.every(p => Array.isArray(p) && p.length === 6 && p.every(Number.isFinite) && p.slice(3).every(r => r > 0))) {
        throw new Error('sculpt expects 1..64 [x,y,z,rx,ry,rz] arrays with positive radii.');
      }
      if (!Number.isFinite(blend) || blend < 0 || blend > 1 || !Number.isInteger(resolution) || resolution < 24 || resolution > 72) {
        throw new Error('Use blend in [0,1] and integer resolution in [24,72].');
      }
      const bounds = new THREE.Box3();
      for (const [x,y,z,rx,ry,rz] of parts) {
        const center = new THREE.Vector3(x,y,z);
        const margin = new THREE.Vector3(rx,ry,rz).multiplyScalar(1 + blend);
        bounds.expandByPoint(center.clone().sub(margin));
        bounds.expandByPoint(center.add(margin));
      }
      // 各轴独立缩放到采样网格，细长物体也能保留横截面的细节。边缘预留三格给法线差分。
      const center = bounds.getCenter(new THREE.Vector3());
      const step = bounds.getSize(new THREE.Vector3()).divideScalar(resolution - 6);
      const material = new THREE.MeshBasicMaterial();
      const volume = new MarchingCubes(resolution, material, false, false, 60000);
      try {
        volume.isolation = 0;
        for (let iz = 0; iz < resolution; iz++) {
          const z = center.z + (iz - resolution / 2) * step.z;
          for (let iy = 0; iy < resolution; iy++) {
            const y = center.y + (iy - resolution / 2) * step.y;
            for (let ix = 0; ix < resolution; ix++) {
              const x = center.x + (ix - resolution / 2) * step.x;
              let field = -Infinity;
              for (const [cx,cy,cz,rx,ry,rz] of parts) {
                const dx = (x-cx)/rx, dy = (y-cy)/ry, dz = (z-cz)/rz;
                const value = 1 - Math.sqrt(dx*dx + dy*dy + dz*dz);
                // 平滑最大值只在两个场接近时起作用。blend=0 对应普通并集。
                const overlap = Math.max(blend - Math.abs(value - field), 0);
                field = Math.max(field, value) + (blend ? overlap * overlap / (4 * blend) : 0);
              }
              volume.setCell(ix, iy, iz, field);
            }
          }
        }
        volume.update();
        const count = volume.count;
        if (!count || count > volume.positionArray.length / 3) throw new Error('Sculpt surface is empty or too dense. Adjust parts or resolution.');
        // MarchingCubes 为动态渲染预分配缓冲区，GLB 只需要实际使用的顶点和光滑法线。
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(volume.positionArray.slice(0, count * 3), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(volume.normalArray.slice(0, count * 3), 3));
        const scale = step.multiplyScalar(resolution / 2);
        geometry.scale(scale.x, scale.y, scale.z);
        geometry.translate(center.x, center.y, center.z);
        return geometry;
      } finally {
        volume.geometry.dispose();
        material.dispose();
      }
    }
    ${dogModelSource}
    export function createModel(source) {
      const root = new Function('THREE', 'sculpt', 'taper', 'makeDog', source)({ ...THREE, RoundedBoxGeometry }, sculpt, taper, makeDog);
      if (!root || !root.isObject3D) throw new Error('Script must return a THREE.Group or THREE.Mesh.');
      root.updateMatrixWorld(true);
      let vertices=0, meshes=0;
      root.traverse(object => { if(object.isMesh) { meshes++; vertices += object.geometry.getAttribute('position')?.count || 0; } });
      if (!meshes || meshes>1000 || vertices>500000) throw new Error('Model must contain 1..1000 meshes and at most 500000 vertices.');
      return root;
    }
    export async function exportModel(root, maxBytes = 20*1024*1024) {
      const bytes = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength>maxBytes) throw new Error('GLB exceeds the export size limit. Simplify the model.');
      return bytes;
    }`;
