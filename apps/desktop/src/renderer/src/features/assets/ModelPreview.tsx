import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { api } from '../../api/client';

/** 只加载已导出的 GLB。建模脚本在 Agent 的独立浏览器中运行，不在桌面端执行。 */
export function ModelPreview({ artifactId }: { artifactId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const element = host.current!;
    const abort = new AbortController();
    let active = true, root: THREE.Object3D | undefined;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError('WebGL 不可用，请检查硬件加速。'); setLoading(false); return; }
    setError(''); setLoading(true);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); element.appendChild(renderer.domElement);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#cbd2d2');
    // 在本地生成摄影棚环境贴图。金属会反射亮面和暗面，倒角、釉面和哑光之间的差别更容易看清。
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const reflection = pmrem.fromScene(room, 0.04);
    scene.environment = reflection.texture;
    scene.environmentIntensity = 0.7;
    room.dispose();
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    const light = new THREE.DirectionalLight(0xfff3df, 1.65);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    scene.add(light, light.target);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.14 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    // GLB 中的纹理和缓冲应内嵌，禁止模型触发外部资源请求。
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => { if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('模型包含外部资源'); return url; });
    const dispose = (object: THREE.Object3D) => object.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    });
    void fetch(api.baseUrl + '/api/artifacts/' + encodeURIComponent(artifactId) + '/model', { credentials: 'include', signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error('无法读取 GLB（' + response.status + '）'); return response.arrayBuffer(); })
      .then(bytes => new GLTFLoader(manager).parseAsync(bytes, ''))
      .then(gltf => {
        if (!active) { dispose(gltf.scene); return; }
        root = gltf.scene; scene.add(root);
        const box = new THREE.Box3().setFromObject(root), center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        // 将接影平面放在模型最低点，跟随资产的实际尺寸调整阴影覆盖范围。
        root.traverse(child => { if (child instanceof THREE.Mesh) child.castShadow = true; });
        floor.scale.setScalar(size * 5);
        floor.position.set(center.x, box.min.y - size * 0.001, center.z);
        light.target.position.copy(center);
        light.position.copy(center).addScaledVector(new THREE.Vector3(-0.65, 2.7, 1), size);
        Object.assign(light.shadow.camera, { left: -size, right: size, top: size, bottom: -size, near: size * 0.1, far: size * 6 });
        light.shadow.camera.updateProjectionMatrix();
        light.shadow.normalBias = size * 0.001;

        // 以包围盒八个角在视线方向上的投影取景，横向模型和窄面板都能完整显示。
        camera.aspect = (element.clientWidth || 1) / (element.clientHeight || 1);
        const view = new THREE.Vector3(0.85, 0.42, 1).normalize();
        const right = new THREE.Vector3().crossVectors(camera.up, view).normalize();
        const up = new THREE.Vector3().crossVectors(view, right);
        const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        let distance = 0;
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          const corner = new THREE.Vector3(x, y, z).sub(center);
          const halfHeight = Math.max(Math.abs(corner.dot(up)), Math.abs(corner.dot(right)) / camera.aspect);
          distance = Math.max(distance, corner.dot(view) + 1.12 * halfHeight / tanY);
        }
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(view, distance || size);
        camera.near = size / 1000; camera.far = Math.max(size * 100, distance + size);
        camera.updateProjectionMatrix();
        controls.update();
        setLoading(false);
      }).catch(error => { if (active) { setError(error instanceof Error ? error.message : String(error)); setLoading(false); } });
    const resize = new ResizeObserver(() => { const width = element.clientWidth, height = element.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); });
    resize.observe(element); renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    return () => {
      active = false; abort.abort(); resize.disconnect(); renderer.setAnimationLoop(null);
      controls.dispose();
      if (root) dispose(root);
      dispose(floor);
      light.shadow.dispose();
      reflection.dispose();
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [artifactId]);
  return <section aria-label="3D 模型预览"><div className="model-preview" ref={host} />{error ? <p role="alert">{error}</p> : <p>{loading ? '正在加载 GLB…' : '拖动旋转 · 滚轮缩放 · 右键平移'}</p>}</section>;
}
