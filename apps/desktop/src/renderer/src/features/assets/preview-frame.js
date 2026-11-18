// 这个文件由 build-preview.ts 接在 model-runtime 后打包进 iframe，不由主页面执行。
// 使用同一份 THREE，避免两份 Three.js 对象导致 instanceof 或导出不一致。
import { OrbitControls } from '../examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '../examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from '../examples/jsm/environments/RoomEnvironment.js';

let initialized = false;
window.addEventListener('message', async event => {
  if (event.source !== window.parent || initialized || event.data?.type !== 'initialize-model' || !event.ports[0]) return;
  initialized = true;
  // 结果只通过转移进来的私有端口返回。生成函数无法读取本闭包中的端口和父页面状态。
  const port = event.ports[0];
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#cbd2d2');
    const room = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(renderer);
    const reflection = pmrem.fromScene(room, 0.04); scene.environment = reflection.texture;
    room.dispose(); pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x596365, 1.5));
    const light = new THREE.DirectionalLight(0xfff3df, 2); light.position.set(-3, 5, 4); scene.add(light);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => { if (!url.startsWith('data:') && !url.startsWith('blob:')) throw Error('模型不允许加载外部资源。'); return url; });
    const generating = typeof event.data.source === 'string';
    const root = generating ? createModel(event.data.source) : (await new GLTFLoader(manager).parseAsync(event.data.bytes, '')).scene;
    scene.add(root);
    const box = new THREE.Box3().setFromObject(root), center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const resize = () => {
      renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / Math.max(innerHeight, 1);
      camera.updateProjectionMatrix();
    };
    resize(); addEventListener('resize', resize);
    const view = new THREE.Vector3(0.85, 0.42, 1).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, view).normalize();
    const up = new THREE.Vector3().crossVectors(view, right);
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); let distance = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const point = new THREE.Vector3(x, y, z).sub(center);
      distance = Math.max(distance, point.dot(view) + 1.15 * Math.max(Math.abs(point.dot(up)), Math.abs(point.dot(right)) / camera.aspect) / tan);
    }
    camera.position.copy(center).addScaledVector(view, distance || size);
    camera.near = size / 1000; camera.far = Math.max(size * 100, distance + size); camera.updateProjectionMatrix();
    controls.target.copy(center); controls.update();
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    if (generating) {
      const bytes = await exportModel(root);
      port.postMessage({ type: 'generated', bytes }, [bytes]);
    } else port.postMessage({ type: 'ready' });
  } catch (error) {
    port.postMessage({ type: 'error', message: (error instanceof Error ? error.message : '客户端构建失败').slice(0, 2000) });
  }
});
