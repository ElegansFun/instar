// The cage, drawn. A glass fly cage on a lab bench, lit by its own lamp: a
// gridded floor, four panes and a lid in an aluminium frame, raised dishes
// of yeast paste and banana, a water pool, a salt-crust corner, and the
// flies as articulated adults built from primitives: head with compound
// eyes and arista, thorax, striped abdomen, six jointed legs whose gait is
// the engine's leg phases, two veined wings beating at the engine's
// wingbeat phase, halteres, a proboscis that extends as the engine says.
// Pure presentation over /api/stream; nothing here feeds back into the world.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { EffectComposer } from "./vendor/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "./vendor/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "./vendor/jsm/postprocessing/BokehPass.js";
import { SMAAPass } from "./vendor/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "./vendor/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "./vendor/jsm/environments/RoomEnvironment.js";

const TAU = Math.PI * 2;
// one flight layer is this many scene units; a floor cell is one unit
const LAYER_H = 6;
// the whole fly rig is drawn in fly units and scaled by this to cells
const FLY = 0.85;
// the body's centre sits this far off the surface it walks on (fly units)
const BODY_H = 0.62;
const IDLE_MS = 30000;
const LEG_NAMES = ["L1", "L2", "L3", "R1", "R2", "R3"];
// surfaces, in the engine's numbering: tangent 1 (cos h), tangent 2 (sin h), normal
const SURFACES = [
  { t1: [1, 0, 0], t2: [0, 0, 1], n: [0, 1, 0] },   // 0 floor
  { t1: [0, 0, 1], t2: [0, 1, 0], n: [1, 0, 0] },   // 1 wall x = 0
  { t1: [0, 0, 1], t2: [0, 1, 0], n: [-1, 0, 0] },  // 2 wall x = G
  { t1: [1, 0, 0], t2: [0, 1, 0], n: [0, 0, 1] },   // 3 wall y = 0
  { t1: [1, 0, 0], t2: [0, 1, 0], n: [0, 0, -1] },  // 4 wall y = G
  { t1: [1, 0, 0], t2: [0, 0, 1], n: [0, -1, 0] },  // 5 ceiling
];

// ---------- small textures, drawn once ----------
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  draw(cv.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
// lab bench paper with a millimetre grid
const paperTex = () => {
  const t = canvasTex(512, 512, (c) => {
    c.fillStyle = "#cbc6b9"; c.fillRect(0, 0, 512, 512);
    const img = c.getImageData(0, 0, 512, 512), d = img.data;
    let s = 12345;
    for (let i = 0; i < 512 * 512; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; const g = ((s >> 8) & 15) - 7; d[i * 4] += g; d[i * 4 + 1] += g; d[i * 4 + 2] += g; }
    c.putImageData(img, 0, 0);
    c.strokeStyle = "rgba(90,80,60,0.13)"; c.lineWidth = 1;
    for (let k = 0; k < 512; k += 64) { c.beginPath(); c.moveTo(k + 0.5, 0); c.lineTo(k + 0.5, 512); c.moveTo(0, k + 0.5); c.lineTo(512, k + 0.5); c.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 40);
  return t;
};
// the cage floor: white PVC ruled every cell, heavier every eight, tinted by
// the temperature gradient from the cold end to the hot end
function floorTex(G, cold, hot) {
  return canvasTex(2048, 2048, (c, w, h) => {
    const px = w / G;
    const grad = c.createLinearGradient(cold[0] * px, cold[1] * px, hot[0] * px, hot[1] * px);
    grad.addColorStop(0, "#e9edf0"); grad.addColorStop(0.5, "#eeece6"); grad.addColorStop(1, "#f1e6d6");
    c.fillStyle = grad; c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(60,58,52,0.10)"; c.lineWidth = 1;
    for (let k = 0; k <= G; k++) { const p = Math.round(k * px) + 0.5; c.beginPath(); c.moveTo(p, 0); c.lineTo(p, h); c.moveTo(0, p); c.lineTo(w, p); c.stroke(); }
    c.strokeStyle = "rgba(60,58,52,0.28)"; c.lineWidth = 2;
    for (let k = 0; k <= G; k += 8) { const p = Math.round(k * px); c.beginPath(); c.moveTo(p, 0); c.lineTo(p, h); c.moveTo(0, p); c.lineTo(w, p); c.stroke(); }
  });
}
// compound eye: red with a hexagonal facet lattice
const eyeTex = () => canvasTex(256, 256, (c, w, h) => {
  c.fillStyle = "#b8281c"; c.fillRect(0, 0, w, h);
  const r = 4, dy = r * 1.732;
  for (let j = -1; j < h / dy + 1; j++) for (let i = -1; i < w / (2 * r) + 1; i++) {
    const x = i * 2 * r + (j % 2 ? r : 0), y = j * dy;
    const g = c.createRadialGradient(x - 1.5, y - 1.5, 0, x, y, r * 0.95);
    g.addColorStop(0, "#e2553f"); g.addColorStop(0.7, "#a41f17"); g.addColorStop(1, "#5a0e0a");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 0.98, 0, TAU); c.fill();
  }
});
// abdomen: pale tergites with dark posterior bands; the last two dark, as
// on a male. v runs along the body from the waist (0) to the tip (1).
const abdomenTex = () => {
  const t = canvasTex(64, 512, (c, w, h) => {
    c.fillStyle = "#c9a468"; c.fillRect(0, 0, w, h);
    // canvas row 0 is the posterior tip (v = 1 after the geometry's turn):
    // dark tip, then bands whose dark edge faces the tip
    const bands = [[0, 0.3], [0.38, 0.5], [0.6, 0.7], [0.8, 0.88]];
    for (const [a, b] of bands) {
      const g = c.createLinearGradient(0, b * h, 0, a * h);
      g.addColorStop(0, "rgba(46,32,18,0)"); g.addColorStop(0.3, "rgba(46,32,18,0.95)"); g.addColorStop(1, "rgba(30,22,14,1)");
      c.fillStyle = g; c.fillRect(0, a * h, w, (b - a) * h);
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
};
// wing membrane with the longitudinal veins and the two cross-veins; u
// across the chord (trailing 0, leading 1), v along the span (hinge 0)
const wingTex = () => canvasTex(256, 512, (c, w, h) => {
  c.clearRect(0, 0, w, h);
  c.fillStyle = "rgba(236,232,220,0.42)"; c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(70,55,35,0.9)"; c.lineCap = "round";
  const vein = (pts, lw) => { c.lineWidth = lw; c.beginPath(); pts.forEach(([u, v], i) => i ? c.lineTo(u * w, v * h) : c.moveTo(u * w, v * h)); c.stroke(); };
  vein([[0.92, 0], [0.96, 0.4], [0.9, 0.98]], 4);          // costa / L1
  vein([[0.8, 0.02], [0.78, 0.5], [0.72, 0.97]], 2.5);     // L2
  vein([[0.66, 0.02], [0.6, 0.55], [0.5, 0.96]], 2.5);     // L3
  vein([[0.55, 0.02], [0.44, 0.5], [0.28, 0.9]], 2.5);     // L4
  vein([[0.45, 0.02], [0.3, 0.4], [0.14, 0.7]], 2);        // L5
  vein([[0.62, 0.3], [0.5, 0.31]], 2);                     // anterior cross-vein
  vein([[0.5, 0.55], [0.38, 0.52]], 2);                    // posterior cross-vein
  vein([[0.35, 0.02], [0.2, 0.2], [0.1, 0.35]], 1.5);      // L6 / anal
}, true);
// yeast paste: cream, lumpy
const yeastTex = () => canvasTex(256, 256, (c, w, h) => {
  c.fillStyle = "#efe4c6"; c.fillRect(0, 0, w, h);
  let s = 777;
  for (let i = 0; i < 900; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff; const x = (s >> 4) % w;
    s = (s * 1103515245 + 12345) & 0x7fffffff; const y = (s >> 4) % h;
    s = (s * 1103515245 + 12345) & 0x7fffffff; const r = 3 + ((s >> 4) % 9);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,250,236,0.9)"); g.addColorStop(1, "rgba(200,180,140,0)");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  }
});
// banana skin going over: yellow with brown bruising and black speckle
const bananaTex = () => canvasTex(512, 256, (c, w, h) => {
  const g = c.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, "#3a2a14"); g.addColorStop(0.1, "#a88a3c"); g.addColorStop(0.5, "#d9b84a"); g.addColorStop(0.9, "#a47e32"); g.addColorStop(1, "#2d2010");
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  let s = 4242;
  for (let i = 0; i < 260; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff; const x = (s >> 4) % w;
    s = (s * 1103515245 + 12345) & 0x7fffffff; const y = (s >> 4) % h;
    s = (s * 1103515245 + 12345) & 0x7fffffff; const r = 2 + ((s >> 4) % 14);
    const rg = c.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, "rgba(60,38,18,0.85)"); rg.addColorStop(1, "rgba(90,60,25,0)");
    c.fillStyle = rg; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  }
});
// salt crust: white, grainy
const saltTex = () => canvasTex(256, 256, (c, w, h) => {
  c.fillStyle = "#e6e2d8"; c.fillRect(0, 0, w, h);
  const img = c.getImageData(0, 0, w, h), d = img.data;
  let s = 99;
  for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; const g = ((s >> 8) & 31) - 8; d[i * 4] += g; d[i * 4 + 1] += g; d[i * 4 + 2] += g + 4; }
  c.putImageData(img, 0, 0);
});

// GTAO with the glass, the water and the light cone left out of its
// normal/depth pass: what is seen through them should shade, not the pane.
class CageGTAO extends GTAOPass {
  constructor(excluded, ...args) { super(...args); this.excluded = excluded; }
  overrideVisibility() { super.overrideVisibility(); for (const m of this.excluded) { this._vis ??= new Map(); this._vis.set(m, m.visible); m.visible = false; } }
  restoreVisibility() { super.restoreVisibility(); if (this._vis) { for (const [m, v] of this._vis) m.visible = v; this._vis.clear(); } }
}

// A cylinder from y = 0 to y = 1, thinner at the top: legs, arista, stalks
function segmentGeometry(taper) {
  const g = new THREE.CylinderGeometry(taper, 1, 1, 7, 1);
  g.translate(0, 0.5, 0);
  return g;
}

export class Cage3D {
  constructor(canvas, { arena, maxPop = 64, embedded = false, onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.embedded = embedded;
    this.G = arena.floor;
    this.LAYERS = arena.layers;
    this.H = arena.layers * LAYER_H;
    this.arena = arena;
    this.MAXP = maxPop;
    this.selected = -1;      // fly uid, not slot: the stream is keyed by id
    this.tracking = -1;
    this.frame = 0;
    this.light = 1;
    this.lastInput = performance.now();
    this.flies = [];         // the last sampled view, for picking and follow

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.78;

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc9c3b4);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const cam = this.cam = new THREE.PerspectiveCamera(38, 1, 0.3, 1200);
    cam.position.set(120, 110, 190);
    const controls = this.controls = new OrbitControls(cam, canvas);
    controls.target.set(0, this.H * 0.3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = 1.5;
    controls.minDistance = 2;
    controls.maxDistance = 600;
    controls.enableZoom = !embedded;
    controls.enablePan = !embedded;
    controls.autoRotateSpeed = 0.3;
    this.userMoved = false;
    const touched = () => { this.lastInput = performance.now(); this.userMoved = true; this.controls.autoRotate = false; };
    for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) canvas.addEventListener(ev, touched, { passive: true });

    // the room: a soft key from a high window, plus sky/ground fill; the
    // cage's own lamp is the light the flies live under
    const key = this.key = new THREE.DirectionalLight(0xfff3e2, 1.4);
    key.position.set(-160, 260, -120);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 50; key.shadow.camera.far = 700;
    const half = this.G * 0.8;
    key.shadow.camera.left = key.shadow.camera.bottom = -half; key.shadow.camera.right = key.shadow.camera.top = half;
    key.shadow.normalBias = 0.3; key.shadow.bias = -0.0005;
    scene.add(key, key.target);
    this.fill = new THREE.HemisphereLight(0xe8eef6, 0x8a806c, 0.4);
    scene.add(this.fill);

    this.aoExcluded = [];
    this.buildBench();
    this.buildCage();
    this.buildDishes();
    this.buildLamp();
    this.buildFlies();

    const composer = this.composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));
    const gtao = this.gtao = new CageGTAO(this.aoExcluded, scene, cam, 1, 1);
    gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1, thickness: 1, scale: 1.0, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
    gtao.blendIntensity = 0.7;
    composer.addPass(gtao);
    const bokeh = this.bokeh = new BokehPass(scene, cam, { focus: 6, aperture: 0.008, maxblur: 0.005 });
    bokeh.enabled = false;
    composer.addPass(bokeh);
    composer.addPass(new SMAAPass());
    composer.addPass(new OutputPass());

    this._m4 = new THREE.Matrix4(); this._m4b = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._f = new THREE.Vector3(); this._u = new THREE.Vector3(); this._r = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._Y = new THREE.Vector3(0, 1, 0);

    this.bindPicking();
    this.bindFirstPerson();
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    this.resize();
  }

  // cell coordinates -> scene
  toScene(x, y, z, out) { return out.set(x - this.G / 2, z * LAYER_H, y - this.G / 2); }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const cam = this.cam, aspect = w / h;
    cam.aspect = aspect;
    if (!this.fp.on) cam.fov = aspect >= 1.2 ? 38 : Math.min(62, 2 * Math.atan(Math.tan(19 * Math.PI / 180) * 1.2 / aspect) * 180 / Math.PI);
    cam.updateProjectionMatrix();
    this.bokeh.uniforms.aspect.value = aspect;
    if (this.userMoved || this.fp.on) return;
    // fit the cage: half-diagonal of the box plus a margin
    const R = Math.hypot(this.G / 2, this.H / 2, this.G / 2) + 6;
    const tv = Math.tan(cam.fov * Math.PI / 360), th = tv * aspect;
    const d = Math.max(R / tv, R / th) * (this.embedded ? 0.98 : aspect < 1.2 ? 1.05 : 1.0);
    const c = this.controls;
    cam.position.sub(c.target).normalize().multiplyScalar(d).add(c.target);
  }

  // ---------- the bench ----------
  buildBench() {
    const bench = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ map: paperTex(), roughness: 0.96 }));
    bench.rotation.x = -Math.PI / 2;
    bench.position.y = -1.2;
    bench.receiveShadow = true;
    this.scene.add(bench);
  }

  // ---------- the cage ----------
  buildCage() {
    const { scene, G, H, arena } = this;
    const half = G / 2;
    // floor: white PVC sheet, ruled
    const floor = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(G, G), new THREE.MeshPhysicalMaterial({
      map: floorTex(G, arena.temp.cold, arena.temp.hot), roughness: 0.75, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.6,
    }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const base = new THREE.Mesh(new THREE.BoxGeometry(G + 2.4, 1.2, G + 2.4), new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.6 }));
    base.position.y = -0.6;
    base.castShadow = base.receiveShadow = true;
    scene.add(base);

    // the salt corner: a dry crust in the corner the engine names
    {
      const [dx, dy] = arena.humidity.dry;
      const sx = dx < G / 2 ? -half : half, sz = dy < G / 2 ? -half : half;
      const R = 14;
      const geo = new THREE.CircleGeometry(R, 40, 0, Math.PI / 2);
      geo.rotateX(-Math.PI / 2);
      const salt = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: saltTex(), roughness: 1, color: 0xf2eee6 }));
      // CircleGeometry's quarter runs from +x toward +y before the rotation
      // (+x toward -z after it); turn it to face the corner
      salt.rotation.y = sx > 0 ? (sz > 0 ? -Math.PI / 2 : 0) : (sz > 0 ? Math.PI : Math.PI / 2);
      salt.position.set(sx, 0.04, sz);
      salt.receiveShadow = true;
      scene.add(salt);
    }

    // panes: four walls and the lid, glass in an aluminium frame
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xeaf2f6, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.13, clearcoat: 1, clearcoatRoughness: 0.03,
      envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false,
    });
    const panes = this.panes = [];
    const pane = (w, h, px, py, pz, ry, rx) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass);
      m.position.set(px, py, pz); m.rotation.set(rx, ry, 0);
      m.renderOrder = 8;
      scene.add(m); panes.push(m);
    };
    pane(G, H, 0, H / 2, -half, 0, 0);
    pane(G, H, 0, H / 2, half, Math.PI, 0);
    pane(G, H, -half, H / 2, 0, Math.PI / 2, 0);
    pane(G, H, half, H / 2, 0, -Math.PI / 2, 0);
    pane(G, G, 0, H, 0, 0, Math.PI / 2);
    this.aoExcluded.push(...panes);
    const alu = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.35, metalness: 0.85 });
    const bar = (len, axis, x, y, z) => {
      const T = 1.4;
      const m = new THREE.Mesh(new THREE.BoxGeometry(axis === "x" ? len : T, axis === "y" ? len : T, axis === "z" ? len : T), alu);
      m.position.set(x, y, z);
      m.castShadow = true;
      scene.add(m);
    };
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(H, "y", sx * half, H / 2, sz * half);
    for (const y of [0.7, H]) for (const s of [-1, 1]) { bar(G, "x", 0, y, s * half); bar(G, "z", s * half, y, 0); }
    // hinge and latch on the front pane, so the lid reads as a lid
    const latch = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1.6), alu);
    latch.position.set(0, H - 4, half + 0.9);
    scene.add(latch);
  }

  // ---------- dishes, water ----------
  buildDishes() {
    const { scene, arena } = this;
    const plastic = new THREE.MeshPhysicalMaterial({ color: 0xf4f1ea, roughness: 0.4, transparent: true, opacity: 0.85, clearcoat: 0.6 });
    const yeastMat = new THREE.MeshPhysicalMaterial({ map: yeastTex(), roughness: 0.55, sheen: 0.6, sheenColor: new THREE.Color(0xfff2d0) });
    const bananaMat = new THREE.MeshPhysicalMaterial({ map: bananaTex(), roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.5 });
    const mush = new THREE.MeshPhysicalMaterial({ color: 0x8a5a2a, roughness: 0.3, clearcoat: 0.8 });
    const v = new THREE.Vector3();
    this.dishes = [];
    for (const d of arena.dishes) {
      this.toScene(d.x, d.y, 0, v);
      const top = d.h * LAYER_H;
      const g = new THREE.Group();
      g.position.set(v.x, 0, v.z);
      if (d.kind === "water") {
        // a shallow pool flush with the floor: a rim and a reflective sheet
        const rim = new THREE.Mesh(new THREE.TorusGeometry(d.r, 0.5, 8, 64), plastic);
        rim.rotation.x = Math.PI / 2; rim.position.y = 0.3;
        const water = new THREE.Mesh(new THREE.CircleGeometry(d.r - 0.2, 64), new THREE.MeshPhysicalMaterial({
          color: 0xdfe8ea, roughness: 0.04, metalness: 0, transmission: 0.6, ior: 1.33, thickness: 1, envMapIntensity: 4, specularIntensity: 1,
        }));
        water.rotation.x = -Math.PI / 2; water.position.y = 0.25;
        water.renderOrder = 7;
        this.aoExcluded.push(water);
        g.add(rim, water);
      } else {
        const dish = new THREE.Mesh(new THREE.CylinderGeometry(d.r, d.r - 0.4, top, 48, 1, true), plastic);
        dish.position.y = top / 2;
        dish.material.side = THREE.DoubleSide;
        const bottom = new THREE.Mesh(new THREE.CylinderGeometry(d.r - 0.4, d.r - 0.4, 0.5, 48), plastic);
        bottom.position.y = 0.25;
        dish.castShadow = true;
        g.add(dish, bottom);
        if (d.kind === "yeast") {
          // paste: a low dome
          const paste = new THREE.Mesh(new THREE.SphereGeometry(d.r - 0.5, 48, 24, 0, TAU, 0, Math.PI / 2), yeastMat);
          paste.scale.y = 0.35;
          paste.position.y = top - (d.r - 0.5) * 0.35 + 0.6;
          paste.castShadow = paste.receiveShadow = true;
          g.add(paste);
        } else if (d.kind === "banana") {
          // a chunk of banana lying in its own mush
          const pool = new THREE.Mesh(new THREE.CircleGeometry(d.r - 0.5, 48), mush);
          pool.rotation.x = -Math.PI / 2; pool.position.y = top - 0.6;
          const chunk = new THREE.Mesh(new THREE.CapsuleGeometry(d.r * 0.32, d.r * 1.1, 6, 24), bananaMat);
          chunk.rotation.z = Math.PI / 2; chunk.rotation.y = 0.5;
          chunk.position.y = top - 0.6 + d.r * 0.28;
          chunk.scale.set(1, 0.85, 1);
          chunk.castShadow = chunk.receiveShadow = true;
          g.add(pool, chunk);
        }
      }
      scene.add(g);
      this.dishes.push({ ...d, group: g });
    }
  }

  // ---------- the lamp ----------
  buildLamp() {
    const { scene, arena, H } = this;
    const v = new THREE.Vector3();
    this.toScene(arena.lamp.x, arena.lamp.y, arena.layers, v);
    const housing = new THREE.Group();
    housing.position.set(v.x, H, v.z);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.5, metalness: 0.6 });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 5, 12), metal);
    stem.position.y = -2.5;
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 5, 5, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide }));
    shade.position.y = -7;
    const bulb = this.bulb = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xffe6b0, emissiveIntensity: 2, roughness: 1 }));
    bulb.position.y = -7.5;
    housing.add(stem, shade, bulb);
    scene.add(housing);
    const lamp = this.lamp = new THREE.SpotLight(0xfff0d2, 900, H * 2.2, 0.72, 0.6, 1.3);
    lamp.position.set(v.x, H - 8, v.z);
    lamp.target.position.set(v.x, 0, v.z);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(1024, 1024);
    lamp.shadow.camera.near = 4; lamp.shadow.camera.far = H * 2;
    lamp.shadow.bias = -0.0008; lamp.shadow.normalBias = 0.25;
    scene.add(lamp, lamp.target);
    // the visible cone: a faint additive volume under the shade
    const coneH = H - 8;
    const cone = this.cone = new THREE.Mesh(new THREE.ConeGeometry(Math.tan(0.72) * coneH, coneH, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.02, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    cone.position.set(v.x, coneH / 2, v.z);
    cone.renderOrder = 6;
    scene.add(cone);
    this.aoExcluded.push(cone);
  }

  // ---------- the flies ----------
  // One instanced mesh per part; a fly's parts are written at its slot every
  // frame from the interpolated stream state.
  buildFlies() {
    const { scene, MAXP } = this;
    const cuticle = new THREE.MeshPhysicalMaterial({ color: 0x9c7a4e, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color(0xd9c39a), sheenRoughness: 0.7 });
    const dark = new THREE.MeshPhysicalMaterial({ color: 0x5a4328, roughness: 0.6 });
    const eye = new THREE.MeshPhysicalMaterial({ map: eyeTex(), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15, emissive: 0x3a0a06, emissiveIntensity: 0.4 });
    const abd = new THREE.MeshPhysicalMaterial({ map: abdomenTex(), roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color(0xe0cfa8) });
    const wing = new THREE.MeshPhysicalMaterial({ map: wingTex(), transparent: true, opacity: 0.9, roughness: 0.15, side: THREE.DoubleSide, depthWrite: false, iridescence: 0.5, iridescenceIOR: 1.3 });
    const fan = new THREE.MeshBasicMaterial({ color: 0xe9e4d6, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const halt = new THREE.MeshPhysicalMaterial({ color: 0xd8c9a8, roughness: 0.5 });
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    const abdGeo = new THREE.SphereGeometry(1, 24, 16);
    abdGeo.rotateZ(Math.PI / 2);  // poles along the body axis so the bands wrap it
    const inst = (geo, mat, per, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, MAXP * per);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = shadow; m.receiveShadow = shadow;
      m.frustumCulled = false;
      for (let i = 0; i < MAXP * per; i++) m.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
      scene.add(m);
      return m;
    };
    // wing outline in (chord, span): the leading edge is +x, the hinge at span 0
    const shape = new THREE.Shape();
    const outline = [[0.02, 0], [0.16, 0.06], [0.24, 0.3], [0.27, 0.6], [0.24, 0.85], [0.12, 0.98], [-0.02, 1], [-0.14, 0.95], [-0.22, 0.75], [-0.24, 0.45], [-0.16, 0.15], [-0.05, 0.02]];
    shape.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
    shape.closePath();
    const wingGeo = new THREE.ShapeGeometry(shape, 12);
    {
      const uv = wingGeo.attributes.uv, pos = wingGeo.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + 0.24) / 0.51, pos.getY(i));
      wingGeo.rotateX(Math.PI / 2);   // (chord, span, 0) -> (chord, 0, span)
    }
    const fanGeo = new THREE.CircleGeometry(1, 24, -1.35, 2.7);
    fanGeo.rotateX(Math.PI / 2);
    this.P = {
      head: inst(sphere, cuticle, 1),
      eye: inst(sphere, eye, 2),
      thorax: inst(sphere, cuticle, 1),
      abdomen: inst(abdGeo, abd, 1),
      leg: inst(segmentGeometry(0.7), dark, 18),
      hair: inst(segmentGeometry(0.8), dark, 5),
      bulb: inst(sphere, dark, 3),
      knob: inst(sphere, halt, 2),
      wing: inst(wingGeo, wing, 2, false),
      fan: inst(fanGeo, fan, 2, false),
    };
    this.P.wing.castShadow = true;
    // per-slot smoothing state: orientation and the flight blend
    this.pose = [];
    for (let i = 0; i < MAXP; i++) this.pose.push({ q: new THREE.Quaternion(), ff: 0, fresh: true, id: -1 });
    this.drawn = new Uint8Array(MAXP);
    // the selection ring
    this.marker = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.07, 8, 48), new THREE.MeshBasicMaterial({ color: 0xc9a227 }));
    this.marker.visible = false;
    scene.add(this.marker);
    // leg geometry in fly units: hips on the thorax, feet at rest
    this.hips = [[0.38, -0.12, -0.26], [0.08, -0.16, -0.3], [-0.24, -0.12, -0.26], [0.38, -0.12, 0.26], [0.08, -0.16, 0.3], [-0.24, -0.12, 0.26]];
    this.feet = [[0.95, -BODY_H, -0.72], [0.12, -BODY_H, -0.98], [-0.78, -BODY_H, -0.82], [0.95, -BODY_H, 0.72], [0.12, -BODY_H, 0.98], [-0.78, -BODY_H, 0.82]];
  }

  // Body orientation from the stream: on a surface the body's up is the
  // surface normal and heading turns in its plane; in flight the body
  // follows heading, pitch and roll.
  targetOrientation(f, q) {
    const F = this._f, U = this._u, R = this._r;
    if (f.mode === 1 || f.s < 0 || f.s > 5) {
      const cp = Math.cos(f.p), sp = Math.sin(f.p);
      F.set(Math.cos(f.h) * cp, sp, Math.sin(f.h) * cp);
      // a flying fly hangs nose-up a little behind its direction of travel
      U.set(0, 1, 0);
      R.crossVectors(F, U).normalize();
      U.crossVectors(R, F).normalize();
      this._q2.setFromAxisAngle(R, -0.3);
      F.applyQuaternion(this._q2); U.applyQuaternion(this._q2);
      // bank: the engine's roll when it gives one, else from the turn rate
      const roll = f.r || Math.max(-0.8, Math.min(0.8, -f.dh * 0.12));
      this._q2.setFromAxisAngle(F, roll);
      U.applyQuaternion(this._q2);
      R.crossVectors(F, U).normalize();
    } else {
      const S = SURFACES[f.s];
      F.set(S.t1[0] * Math.cos(f.h) + S.t2[0] * Math.sin(f.h), S.t1[1] * Math.cos(f.h) + S.t2[1] * Math.sin(f.h), S.t1[2] * Math.cos(f.h) + S.t2[2] * Math.sin(f.h));
      U.set(S.n[0], S.n[1], S.n[2]);
      R.crossVectors(F, U).normalize();
    }
    this._m4b.makeBasis(F, U, R);
    q.setFromRotationMatrix(this._m4b);
  }

  // matrix for a segment from a to b (fly-local), radius r, under body matrix M
  segment(M, a, b, r, mesh, index) {
    const d = this._v3.subVectors(b, a);
    const len = d.length();
    if (len < 1e-5) { mesh.setMatrixAt(index, this._zero); return; }
    d.multiplyScalar(1 / len);
    this._q2.setFromUnitVectors(this._Y, d);
    this._m4.compose(a, this._q2, this._v2.set(r, len, r)).premultiply(M);
    mesh.setMatrixAt(index, this._m4);
  }
  part(M, x, y, z, sx, sy, sz, mesh, index, rot) {
    this._m4.compose(this._v.set(x, y, z), rot || this._q2.identity(), this._v2.set(sx, sy, sz)).premultiply(M);
    mesh.setMatrixAt(index, this._m4);
  }

  updateFlies(flies, dt) {
    const P = this.P, M = this._m4b, drawn = this.drawn;
    drawn.fill(0);
    const hip = this._v, foot = this._v2, knee = new THREE.Vector3(), ankle = new THREE.Vector3(), tmp = new THREE.Vector3();
    const pos = new THREE.Vector3(), q = this._q;
    const legR = 0.045 * FLY, hairR = 0.018 * FLY;
    const lf = 0.58, lt = 0.72;
    const blend = 1 - Math.exp(-dt * 9);
    let selPos = null, selUp = null;
    for (const f of flies) {
      const i = f.slot;
      if (i < 0 || i >= this.MAXP) continue;
      drawn[i] = 1;
      const st = this.pose[i];
      if (st.id !== f.id) { st.id = f.id; st.fresh = true; st.ff = f.mode ? 1 : 0; }
      this.targetOrientation(f, q);
      if (st.fresh) { st.q.copy(q); st.fresh = false; } else st.q.slerp(q, blend);
      st.ff += ((f.mode ? 1 : 0) - st.ff) * blend;
      const ff = st.ff;
      this.toScene(f.x, f.y, f.z, pos);
      // the body sits off its surface by BODY_H; in flight the position is the body itself
      tmp.set(0, 1, 0).applyQuaternion(st.q);
      pos.addScaledVector(tmp, BODY_H * FLY * (1 - ff) + 0.15 * ff);
      M.compose(pos, st.q, tmp.set(FLY, FLY, FLY));
      // head, eyes, antennae, arista
      this.part(M, 1.0, 0.08, 0, 0.3, 0.33, 0.34, P.head, i);
      this.part(M, 1.06, 0.1, -0.24, 0.24, 0.3, 0.17, P.eye, 2 * i);
      this.part(M, 1.06, 0.1, 0.24, 0.24, 0.3, 0.17, P.eye, 2 * i + 1);
      for (let s = -1; s <= 1; s += 2) {
        const k = s < 0 ? 0 : 1;
        this.part(M, 1.26, 0.06, s * 0.11, 0.06, 0.06, 0.06, P.bulb, 3 * i + k);
        hip.set(1.26, 0.06, s * 0.11);
        foot.set(1.26 + 0.16, 0.06 + 0.24, s * (0.11 + 0.2));
        this.segment(M, hip, foot, hairR * 0.6, P.hair, 5 * i + k);
      }
      // proboscis: extends from under the head by the engine's value
      hip.set(0.98, -0.16, 0);
      foot.set(0.98 + 0.12 * (0.3 + f.pr), -0.16 - (0.14 + 0.5 * f.pr), 0);
      this.segment(M, hip, foot, 0.05, P.hair, 5 * i + 2);
      this.part(M, foot.x, foot.y, foot.z, 0.1, 0.07, 0.11, P.bulb, 3 * i + 2);
      // thorax, abdomen
      this.part(M, 0.12, 0.14, 0, 0.62, 0.5, 0.46, P.thorax, i);
      this.part(M, -0.98, 0.04, 0, 0.82, 0.38, 0.44, P.abdomen, i);
      // legs: gait from the six phases; tucked under the body in flight
      for (let k = 0; k < 6; k++) {
        const h = this.hips[k], r = this.feet[k];
        const phase = f.legs[k] / 256;
        let along, lift;
        if (phase < 0.6) { const s = phase / 0.6; along = 0.26 - 0.52 * s; lift = 0; }
        else { const s = (phase - 0.6) / 0.4; along = -0.26 + 0.52 * s; lift = Math.sin(Math.PI * s) * 0.28; }
        hip.set(h[0], h[1], h[2]);
        foot.set(r[0] + along, r[1] + lift, r[2]);
        if (ff > 0.001) {
          // in flight the legs fold up and back against the body
          tmp.set(h[0] - 0.25, h[1] - 0.28, h[2] * 1.5);
          foot.lerp(tmp, ff);
        }
        // the ankle: the tarsus lies flat toward the hip
        tmp.set(hip.x - foot.x, 0, hip.z - foot.z).normalize().multiplyScalar(0.34);
        ankle.copy(foot).add(tmp); ankle.y += 0.1 + 0.1 * ff;
        // two-bone IK for femur/tibia; the knee rises up and outward
        tmp.subVectors(ankle, hip);
        let d = tmp.length();
        const reach = lf + lt - 0.01;
        if (d > reach) { tmp.multiplyScalar(reach / d); ankle.copy(hip).add(tmp); d = reach; }
        const a = (lf * lf - lt * lt + d * d) / (2 * d);
        const hh = Math.sqrt(Math.max(0, lf * lf - a * a));
        tmp.multiplyScalar(1 / d);
        knee.copy(hip).addScaledVector(tmp, a);
        // pole: up plus outward, made perpendicular to the hip-ankle line
        this._v3.set(0, 1, Math.sign(h[2]) * 0.7);
        this._v3.addScaledVector(tmp, -this._v3.dot(tmp)).normalize();
        knee.addScaledVector(this._v3, hh);
        this.segment(M, hip, knee, legR * 1.3, P.leg, 18 * i + 3 * k);
        this.segment(M, knee, ankle, legR, P.leg, 18 * i + 3 * k + 1);
        this.segment(M, ankle, foot, legR * 0.7, P.leg, 18 * i + 3 * k + 2);
      }
      // wings: folded back at rest; in flight sweeping about the hinge at the
      // wingbeat phase, rotating about their own span through the stroke
      const wbA = f.wb * TAU;
      for (let s = -1; s <= 1; s += 2) {
        const k = s < 0 ? 0 : 1;
        const restSweep = -1.22, flightSweep = 0.15 + 1.1 * Math.sin(wbA);
        const sweep = restSweep + (flightSweep - restSweep) * ff;
        const tilt = -0.55 * ff;
        const feather = (0.65 * Math.cos(wbA)) * ff;
        // the left wing is the right one mirrored across the body plane:
        // rotations about x and y flip sign, the span scale flips too
        this._e.set(s * tilt, s * sweep, feather, "XYZ");
        this._q2.setFromEuler(this._e);
        this._m4.compose(this._v.set(0.12, 0.3, s * 0.2), this._q2, this._v3.set(2.5, 2.5, s * 2.5)).premultiply(M);
        P.wing.setMatrixAt(2 * i + k, this._m4);
        if (ff > 0.35) {
          this._e.set(s * -0.55, s * 0.15, 0, "XYZ");
          this._q2.setFromEuler(this._e);
          this._m4.compose(this._v.set(0.12, 0.3, s * 0.2), this._q2, this._v3.set(2.5, 2.5, s * 2.5)).premultiply(M);
          P.fan.setMatrixAt(2 * i + k, this._m4);
        } else P.fan.setMatrixAt(2 * i + k, this._zero);
        // halteres: a stalk and a knob behind the wing, beating in antiphase
        const swing = -Math.sin(wbA) * 0.8 * ff;
        hip.set(-0.32, 0.06, s * 0.3);
        foot.set(-0.32 - 0.16 * Math.cos(swing), 0.06 + 0.14 + 0.2 * Math.sin(swing), s * (0.3 + 0.22));
        this.segment(M, hip, foot, hairR, P.hair, 5 * i + 3 + k);
        this.part(M, foot.x, foot.y, foot.z, 0.06, 0.06, 0.06, P.knob, 2 * i + k);
      }
      if (f.id === this.selected) { selPos = pos.clone(); selUp = tmp.set(0, 1, 0).applyQuaternion(st.q).clone(); }
    }
    for (let i = 0; i < this.MAXP; i++) {
      if (drawn[i]) continue;
      if (this.pose[i].id === -1) continue;
      this.pose[i].id = -1;
      P.head.setMatrixAt(i, this._zero); P.thorax.setMatrixAt(i, this._zero); P.abdomen.setMatrixAt(i, this._zero);
      for (let k = 0; k < 2; k++) { P.eye.setMatrixAt(2 * i + k, this._zero); P.wing.setMatrixAt(2 * i + k, this._zero); P.fan.setMatrixAt(2 * i + k, this._zero); P.knob.setMatrixAt(2 * i + k, this._zero); }
      for (let k = 0; k < 3; k++) P.bulb.setMatrixAt(3 * i + k, this._zero);
      for (let k = 0; k < 5; k++) P.hair.setMatrixAt(5 * i + k, this._zero);
      for (let k = 0; k < 18; k++) P.leg.setMatrixAt(18 * i + k, this._zero);
    }
    for (const k in P) P[k].instanceMatrix.needsUpdate = true;
    if (selPos) {
      this.marker.position.copy(selPos).addScaledVector(selUp, -BODY_H * FLY + 0.06);
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), selUp);
      this.marker.visible = true;
    } else if (this.selected >= 0) this.select(-1);
  }

  select(id) {
    this.selected = id;
    this.marker.visible = id >= 0;
    this.onSelect(id);
  }
  flyById(id) { for (const f of this.flies) if (f.id === id) return f; return null; }

  // ---------- light ----------
  // `light` is the world's 0..255 ambient: the cage lamp and the room dim
  // with it; the visible cone shows more when the room is dark
  updateLight(light) {
    const l = light / 255;
    this.light = l;
    this.lamp.intensity = 80 + 620 * l;
    this.bulb.material.emissiveIntensity = 0.2 + 2.2 * l;
    this.key.intensity = 0.12 + 1.0 * l;
    this.key.color.setRGB(0.72 + 0.28 * l, 0.78 + 0.17 * l, 0.92 - 0.04 * l);
    this.fill.intensity = 0.06 + 0.34 * l;
    this.scene.environmentIntensity = 0.12 + 0.6 * l;
    this.scene.background.setRGB(0.62 * (0.22 + 0.78 * l), 0.60 * (0.24 + 0.76 * l), 0.56 * (0.34 + 0.66 * l));
    this.cone.material.opacity = 0.004 + 0.03 * l;
  }

  // ---------- picking ----------
  bindPicking() {
    const canvas = this.canvas;
    let downAt = null;
    canvas.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
    canvas.addEventListener("pointerup", (ev) => {
      const locked = this.fp.mode === "locked";
      if (!locked && (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5)) return;
      const rect = canvas.getBoundingClientRect();
      const cx = locked ? rect.left + rect.width / 2 : ev.clientX;
      const cy = locked ? rect.top + rect.height / 2 : ev.clientY;
      const hit = this.pick(cx - rect.left, cy - rect.top, rect.width, rect.height);
      if (hit >= 0) { this.select(hit === this.selected ? -1 : hit); return; }
      if (this.selected >= 0) this.select(-1);
    });
    // double-click follows a fly; double-click on nothing lets go
    canvas.addEventListener("dblclick", (ev) => {
      if (this.fp.on) return;
      const rect = canvas.getBoundingClientRect();
      const hit = this.pick(ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height);
      this.tracking = hit;
      if (hit >= 0 && this.selected !== hit) this.select(hit);
    });
  }
  pick(px, py, w, h) {
    const v = this._v;
    let best = -1, bestD = 28;
    for (const f of this.flies) {
      this.toScene(f.x, f.y, f.z, v).project(this.cam);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - px, (-v.y * 0.5 + 0.5) * h - py);
      if (d < bestD) { bestD = d; best = f.id; }
    }
    return best;
  }

  // ---------- camera: follow, drift ----------
  updateCamera(dt) {
    const c = this.controls;
    if (this.tracking >= 0) {
      const f = this.flyById(this.tracking);
      if (!f) this.tracking = -1;
      else {
        const p = this.toScene(f.x, f.y, f.z, this._v);
        const k = 1 - Math.exp(-dt * 5);
        const dx = (p.x - c.target.x) * k, dy = (p.y - c.target.y) * k, dz = (p.z - c.target.z) * k;
        c.target.x += dx; c.target.y += dy; c.target.z += dz;
        this.cam.position.x += dx; this.cam.position.y += dy; this.cam.position.z += dz;
      }
    }
    c.autoRotate = performance.now() - this.lastInput > IDLE_MS;
    c.update();
  }

  // ---------- first person: on the glass ----------
  // The visitor is a fly on the inside of a pane. `u` runs around the four
  // walls (0..4G), `v` is height; crawling past a corner continues on the
  // next pane. Yaw and pitch are in world terms so the view does not jump at
  // a corner.
  bindFirstPerson() {
    this.fp = { on: false, mode: null, yaw: 0, pitch: -0.1, vu: 0, vv: 0, keys: {}, u: 0, v: 0, fallback: 0 };
    this.savedCam = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this.onFpChange = () => {};
    const canvas = this.canvas;
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === canvas) {
        clearTimeout(this.fp.fallback);
        this.fp.mode = "locked";
        if (this.fp.on) this.onFpChange(true); else this.enterFP();
      } else if (this.fp.mode === "locked") this.exitFP();
    });
    document.addEventListener("pointerlockerror", () => { clearTimeout(this.fp.fallback); if (!this.fp.on) { this.fp.mode = "drag"; this.enterFP(); } });
    document.addEventListener("mousemove", (e) => {
      if (!this.fp.on) return;
      if (this.fp.mode === "drag" && e.buttons !== 1) return;
      this.lastInput = performance.now();
      this.fp.yaw -= e.movementX * 0.0026;
      this.fp.pitch = Math.max(-1.4, Math.min(1.4, this.fp.pitch - e.movementY * 0.0024));
    });
    document.addEventListener("keydown", (e) => {
      if (!this.fp.on) return;
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      this.lastInput = performance.now();
      this.fp.keys[e.code] = true;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      if (e.code === "Escape" && this.fp.mode === "drag") this.exitFP();
    });
    document.addEventListener("keyup", (e) => { this.fp.keys[e.code] = false; });
  }
  toggleFirstPerson() {
    if (this.fp.on) {
      if (this.fp.mode === "locked") document.exitPointerLock(); else this.exitFP();
      return;
    }
    let rejected = false;
    const fallBack = () => { if (rejected) return; rejected = true; clearTimeout(this.fp.fallback); if (!this.fp.on) { this.fp.mode = "drag"; this.enterFP(); } };
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(fallBack);
    } catch { fallBack(); }
    this.fp.fallback = setTimeout(() => { if (!this.fp.on && !rejected) { this.fp.mode = "drag"; this.enterFP(); } }, 400);
  }
  // pane position and inward normal for a perimeter coordinate
  paneAt(u, out, normal) {
    const G = this.G, half = G / 2;
    u = ((u % (4 * G)) + 4 * G) % (4 * G);
    if (u < G) { out.set(-half + u, 0, -half); normal.set(0, 0, 1); }
    else if (u < 2 * G) { out.set(half, 0, -half + (u - G)); normal.set(-1, 0, 0); }
    else if (u < 3 * G) { out.set(half - (u - 2 * G), 0, half); normal.set(0, 0, -1); }
    else { out.set(-half, 0, half - (u - 3 * G)); normal.set(1, 0, 0); }
  }
  enterFP() {
    if (this.fp.on) return;
    const fp = this.fp;
    this.savedCam.pos.copy(this.cam.position);
    this.savedCam.target.copy(this.controls.target);
    // start on the pane nearest the selected fly (or the first one), at its
    // height, looking at it
    const G = this.G, half = G / 2;
    const f = (this.selected >= 0 && this.flyById(this.selected)) || this.flies[0] || null;
    const p = f ? this.toScene(f.x, f.y, f.z, this._v) : this._v.set(0, this.H * 0.3, 0);
    const dists = [p.z + half, half - p.x, half - p.z, p.x + half];
    let side = 0;
    for (let k = 1; k < 4; k++) if (dists[k] < dists[side]) side = k;
    fp.u = side === 0 ? p.x + half : side === 1 ? G + (p.z + half) : side === 2 ? 2 * G + (half - p.x) : 3 * G + (half - p.z);
    fp.v = Math.max(2, Math.min(this.H - 2, p.y));
    const eye = this._v2, n = this._v3;
    this.paneAt(fp.u, eye, n);
    eye.y = fp.v;
    fp.yaw = Math.atan2(-(p.x - eye.x), -(p.z - eye.z));
    fp.pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(p.y - eye.y, Math.hypot(p.x - eye.x, p.z - eye.z))));
    fp.vu = fp.vv = 0;
    fp.on = true;
    this.tracking = -1;
    this.controls.enabled = false;
    this.bokeh.enabled = true;
    this.onFpChange(true);
  }
  exitFP() {
    const fp = this.fp;
    fp.on = false; fp.mode = null; fp.keys = {};
    this.controls.enabled = true;
    this.bokeh.enabled = false;
    this.cam.position.copy(this.savedCam.pos);
    this.controls.target.copy(this.savedCam.target);
    this.resize();
    this.onFpChange(false);
  }
  stepFP(dt) {
    const fp = this.fp, k = fp.keys;
    const maxSpeed = k.ShiftLeft ? 14 : 6;
    // A/D crawl along the pane, W/S climb and descend; the direction along
    // the pane follows where the visitor looks so "left" is left on screen
    const eye = this._v2, n = this._v3;
    this.paneAt(fp.u, eye, n);
    const look = this._v.set(-Math.sin(fp.yaw), 0, -Math.cos(fp.yaw));
    const tangent = this._f.set(-n.z, 0, n.x);   // +u direction on this pane
    const facing = Math.sign(look.dot(tangent)) || 1;
    let mu = 0, mv = 0;
    if (k.KeyA || k.ArrowLeft) mu -= facing;
    if (k.KeyD || k.ArrowRight) mu += facing;
    if (k.KeyW || k.ArrowUp) mv += 1;
    if (k.KeyS || k.ArrowDown) mv -= 1;
    const len = Math.hypot(mu, mv) || 1;
    const blend = Math.min(1, dt * 9);
    fp.vu += ((mu / len) * maxSpeed - fp.vu) * blend;
    fp.vv += ((mv / len) * maxSpeed - fp.vv) * blend;
    fp.u += fp.vu * dt;
    fp.v = Math.max(1.5, Math.min(this.H - 1.5, fp.v + fp.vv * dt));
    this.paneAt(fp.u, eye, n);
    eye.y = fp.v;
    this.cam.position.copy(eye).addScaledVector(n, 0.8);
    this.cam.quaternion.setFromEuler(this._e.set(fp.pitch, fp.yaw, 0, "YXZ"));
    this.cam.fov = 66; this.cam.updateProjectionMatrix();
    this.bokeh.uniforms.focus.value = 8;
  }

  // ---------- frame ----------
  // `flies` is the stream's interpolated view; `light` the world's 0..255
  render(flies, light, dt) {
    this.frame++;
    this.flies = flies;
    this.updateLight(light);
    this.updateFlies(flies, dt);
    if (this.fp.on) this.stepFP(dt); else this.updateCamera(dt);
    this.composer.render();
  }
}
