/** 随浏览器建模运行库一起编译。坐标约定：狗看向 +X，Y 向上，Z 是身体左右。 */
export const dogModelSource = `
function makeDog({ coat = '#ece5d6', spots = false, spotColor = '#211e1c', collar = null, slender = false } = {}) {
  const dog = new THREE.Group();
  dog.name = 'Dog';
  // 在同一坐标系里搭骨架，最后统一换算为米，肩高约 60 厘米。
  dog.scale.setScalar(0.6);
  if (slender) dog.scale.multiply(new THREE.Vector3(1.07, 1.03, 0.94));
  const fur = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: spotColor, roughness: 0.85 });
  const nose = new THREE.MeshStandardMaterial({ color: '#24201e', roughness: 0.48 });
  const eye = new THREE.MeshStandardMaterial({ color: '#35251a', roughness: 0.22 });
  const glint = new THREE.MeshStandardMaterial({ color: '#fff3d5', roughness: 0.24 });
  function add(name, geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    dog.add(mesh);
    return mesh;
  }
  function oval(name, position, radii, material) {
    const mesh = add(name, new THREE.SphereGeometry(1, 32, 20), material);
    mesh.position.set(...position);
    mesh.scale.set(...radii);
    return mesh;
  }
  const skin = sculpt([
    [-0.59,0.79,0, 0.33,0.25,0.19], [-0.25,0.81,0, 0.48,slender ? 0.157 : 0.19,0.16],
    [0.08,0.77,0, 0.40,0.28,0.21], [0.31,0.77,0, 0.26,0.32,0.20],
    [0.41,0.91,0, 0.20,0.25,0.17], [0.49,1.05,0, 0.17,0.24,0.145],
    [0.57,1.20,0, 0.15,0.20,0.133], [0.66,1.33,0, 0.202,0.185,0.158],
    [0.77,1.30,0, 0.17,0.132,0.138], [0.88,1.265,0, 0.195,0.092,0.115],
    [0.99,1.275,0, 0.107,0.076,0.093],
  ], 0.44, 66);
  // 用一条从毛色过渡到斑色的色带。每个顶点记录到斑点边缘的距离，
  // 渲染器逐像素查色带，让边缘比直接给三角形的三个角涂黑白两色更圆滑。
  const paint = fur.clone();
  if (spots) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 2;
    const ctx = canvas.getContext('2d');
    const ramp = ctx.createLinearGradient(0,0,128,0);
    ramp.addColorStop(0.47,new THREE.Color(coat).getStyle());
    ramp.addColorStop(0.53,new THREE.Color(spotColor).getStyle());
    ctx.fillStyle = ramp;
    ctx.fillRect(0,0,128,2);
    paint.color.set(0xffffff);
    paint.map = new THREE.CanvasTexture(canvas);
    paint.map.colorSpace = THREE.SRGBColorSpace;
  }
  function mottled(geometry) {
    if (!spots) return fur;
    // 细分长边，再合并共用顶点，细小花纹才有足够的采样点，GLB 也能复用顶点。
    geometry.copy(mergeVertices(new TessellateModifier(0.017,5).modify(geometry), 0.00001));
    geometry.normalizeNormals();
    const position = geometry.getAttribute('position');
    const uv = new Float32Array(position.count * 2);
    const hash = n => { const f = Math.sin(n) * 43758.5453; return f - Math.floor(f); };
    const cell = 0.135;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)/cell, y = position.getY(i)/cell, z = position.getZ(i)/cell;
      let nearestEdge = -1;
      for (let a = Math.floor(x)-1; a <= Math.floor(x)+1; a++) {
        for (let b = Math.floor(y)-1; b <= Math.floor(y)+1; b++) {
          for (let c = Math.floor(z)-1; c <= Math.floor(z)+1; c++) {
            const seed = a*137.13 + b*73.61 + c*41.37;
            const dx = x-a-hash(seed+1), dy = y-b-hash(seed+2), dz = z-c-hash(seed+3);
            const edge = 0.27 + 0.22*hash(seed+4) - Math.sqrt(dx*dx + 1.2*dy*dy + dz*dz);
            nearestEdge = Math.max(nearestEdge, edge);
          }
        }
      }
      uv[2*i] = THREE.MathUtils.clamp(0.5 + nearestEdge, 0, 1);
      uv[2*i+1] = 0.5;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return paint;
  }
  add('Coat', skin, mottled(skin));
  // 每行是中心和两个横截面半径。前腿从肩到腕，后腿经膝、飞节再到脚掌。
  for (const side of [-1, 1]) {
    const z = side * 0.139;
    const stride = side * 0.050;
    const front = taper([
      [0.30,0.88,z,0.153,0.09], [0.30,0.68,z,0.125,0.080],
      [0.25,0.47,z,0.074,0.054], [0.28+stride,0.25,z,0.044,0.040],
      [0.28+stride,0.11,z,0.044,0.038], [0.31+stride,0.060,z,0.046,0.043],
    ]);
    const hind = taper([
      [-0.57,0.87,z,0.173,0.099], [-0.56,0.68,z,0.156,0.092],
      [-0.47,0.49,z,0.102,0.067], [-0.57,0.32,z,0.075,0.047],
      [-0.69-stride,0.19,z,0.054,0.040], [-0.66-stride,0.062,z,0.036,0.037],
    ]);
    add('Foreleg'+side, front, mottled(front));
    add('Hindleg'+side, hind, mottled(hind));
    for (const [name,x] of [['Front paw',0.34+stride],['Hind paw',-0.63-stride]]) {
      oval(name+side, [x,0.052,z], [0.083,0.052,0.054], fur);
      for (const dz of [-0.029,0,0.029]) oval(name+' toe', [x+0.045,0.035,z+dz], [0.046,0.030,0.023], fur);
    }
    const ear = taper([
      [0.627,1.449,side*0.089,0.044,0.020], [0.611,1.421,side*0.138,0.093,0.031],
      [0.578,1.344,side*0.166,0.094,0.031], [0.55,1.258,side*0.178,0.078,0.026],
      [0.551,1.187,side*0.175,0.040,0.019], [0.565,1.170,side*0.17,0.007,0.006],
    ]);
    // 几何体使用全身坐标构建；把局部原点移到耳根，旋转耳朵时才会绕耳根转动。
    ear.translate(-0.627,-1.449,-side*0.089);
    add('Ear'+side, ear, spots ? dark : fur).position.set(0.627,1.449,side*0.089);
    oval('Eye'+side, [0.778,1.365,side*0.133], [0.034,0.026,0.022], eye);
    oval('Eye glint'+side,[0.788,1.375,side*0.151],[0.006,0.006,0.004],glint);
    const lip = taper([[0.857,1.222,side*0.099,0.003,0.003],[0.921,1.219,side*0.105,0.006,0.004],[1.027,1.247,side*0.075,0.003,0.003]]);
    add('Mouth'+side, lip, nose);
  }
  oval('Nose', [1.064,1.299,0], [0.058,0.047,0.078], nose);
  const tail = taper([[-0.78,0.90,0,0.092,0.083],[-0.98,0.87,0.035,0.066,0.060],
    [-1.15,0.89,0.075,0.046,0.044],[-1.31,0.98,0.095,0.025,0.022],[-1.40,1.08,0.10,0.002,0.002]]);
  const tailMaterial = mottled(tail);
  tail.translate(0.78,-0.90,0);
  add('Tail', tail, tailMaterial).position.set(-0.78,0.90,0);
  if (collar) {
    // 用斜放的圆环围住颈部，截面贴合脖子的宽度。
    const band = add('Collar', new THREE.CylinderGeometry(0.159,0.163,0.049,56,1,true),
      new THREE.MeshStandardMaterial({ color: collar, roughness: 0.56, side: THREE.DoubleSide }));
    band.position.set(0.519,1.107,0);
    band.scale.x = 1.16;
    band.rotation.z = -0.43;
    oval('Tag', [0.655,1.028,0.043], [0.014,0.044,0.031],
      new THREE.MeshStandardMaterial({ color: '#b28a49', roughness: 0.32, metalness: 0.8 }));
  }
  return dog;
}
`;
