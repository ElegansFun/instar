// The dish, drawn. A petri plate on cream paper: agar washed by moisture,
// yeast colonies, a fruit piece, pools, a lit patch, a day/night lamp, and
// larvae as translucent segmented tubes with dark mouth hooks and a gut whose
// colour follows what they have eaten. Pure presentation over the engine's
// memory; nothing here feeds back into the deterministic state.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { EffectComposer } from "./vendor/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/jsm/postprocessing/RenderPass.js";
import { SMAAPass } from "./vendor/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "./vendor/jsm/postprocessing/OutputPass.js";
import { BIOME } from "./engine.js";

const PAPER = 0xf3eee3, INK = 0x141311, AMBER = 0xc98a2b;
// one flat wash per substrate, indexed by biome id from the engine
const WASH = [
  [0, 0, 0],             // 0 WALL (never drawn)
  [0.914, 0.886, 0.788], // 1 AGAR   #E9E2C9
  [0.965, 0.945, 0.870], // 2 YEAST  pale colony
  [0.690, 0.455, 0.208], // 3 FRUIT  rotting fruit
  [0.878, 0.827, 0.690], // 4 DRY    crust
  [0.690, 0.745, 0.745], // 5 POOL   standing liquid
  [0.985, 0.975, 0.930], // 6 LIT    the lit patch
  [0.851, 0.816, 0.710], // 7 RIM
];
const TAU = Math.PI * 2;
const SEGLEN = 0.42;
const RADIAL = 8;
// fusiform: blunt head, fat middle, pointed tail; one ring per segment plus a head and tail ring
const RADII_PROFILE = [0.22, 0.29, 0.32, 0.335, 0.34, 0.335, 0.32, 0.30, 0.27, 0.23, 0.18, 0.12, 0.05];

export class Dish3D {
  constructor(canvas, world, { embedded = false, onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.world = world;
    this.onSelect = onSelect;
    this.embedded = embedded;
    this.selected = -1;
    this.frame = 0;
    const s = world.sim;
    this.G = world.G; this.R = world.R; this.NSEG = world.NSEG; this.MAXP = world.MAXP;
    this.RINGS = this.NSEG + 2;
    this.radii = new Float32Array(this.RINGS);
    for (let r = 0; r < this.RINGS; r++) {
      this.radii[r] = RADII_PROFILE[Math.round((r / (this.RINGS - 1)) * (RADII_PROFILE.length - 1))];
    }
    this.foodcap = [];
    for (let b = 0; b < 8; b++) this.foodcap[b] = Math.max(1, s.biome_foodcap(b));

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(PAPER);
    const cam = this.cam = new THREE.PerspectiveCamera(46, 1, 0.3, 900);
    cam.position.set(0, 96, 74);
    const controls = this.controls = new OrbitControls(cam, canvas);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = 1.48;
    controls.minDistance = 6;
    controls.maxDistance = 240;
    controls.enableZoom = !embedded;
    controls.enablePan = !embedded;

    // lamp over the bench plus a soft fill; the lamp dims with the engine's day/night
    this.hemi = new THREE.HemisphereLight(0xfff8ea, 0xd8cfb8, 0.7);
    scene.add(this.hemi);
    const lamp = this.lamp = new THREE.DirectionalLight(0xfff3df, 1.25);
    lamp.position.set(40, 120, 30);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.camera.left = -70; lamp.shadow.camera.right = 70;
    lamp.shadow.camera.top = 70; lamp.shadow.camera.bottom = -70;
    lamp.shadow.camera.near = 40; lamp.shadow.camera.far = 260;
    lamp.shadow.bias = -0.0008;
    scene.add(lamp);
    scene.add(lamp.target);

    this.buildDish();
    this.buildLarvae();

    const composer = this.composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));
    composer.addPass(new SMAAPass());
    composer.addPass(new OutputPass());

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    this.resize();
    this.bindPicking();
    this.bindFirstPerson();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  // ---------- the plate ----------
  buildDish() {
    const { G, R, scene } = this;
    // agar: a disc textured straight from the engine's grid
    const tex = this.agarTex = new THREE.DataTexture(new Uint8Array(G * G * 4), G, G, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const agarGeo = new THREE.CircleGeometry(R, 160);
    agarGeo.rotateX(-Math.PI / 2);
    {
      const pos = agarGeo.attributes.position, uv = agarGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + G / 2) / G, (pos.getZ(i) + G / 2) / G);
      uv.needsUpdate = true;
    }
    const agar = new THREE.Mesh(agarGeo, new THREE.MeshLambertMaterial({ map: tex }));
    agar.receiveShadow = true;
    this.agar = agar;
    scene.add(agar);

    // a thin bed under the agar so the plate has a bottom when seen from low angles
    const bed = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 1.6, R + 1.6, 1.2, 128),
      new THREE.MeshLambertMaterial({ color: 0xded5bd }));
    bed.position.y = -0.61;
    scene.add(bed);

    // the wall: clear polystyrene, drawn as a faint double-sided skin, and a rim
    const wallMat = new THREE.MeshPhysicalMaterial({
      color: 0xf6f2e8, transparent: true, opacity: 0.22, roughness: 0.25, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.6, R + 1.6, 7, 128, 1, true), wallMat);
    wall.position.y = 3.5 - 0.6;
    wall.renderOrder = 4;
    scene.add(wall);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 1.6, 0.45, 8, 160),
      new THREE.MeshLambertMaterial({ color: 0xcfc7b0 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 6.4;
    scene.add(rim);
    const foot = new THREE.Mesh(new THREE.TorusGeometry(R + 1.6, 0.5, 8, 160),
      new THREE.MeshLambertMaterial({ color: 0x9e9682 }));
    foot.rotation.x = Math.PI / 2;
    foot.position.y = -1.1;
    scene.add(foot);

    // a printed grid under the plate: the bench is paper
    const grid = new THREE.GridHelper(400, 40, 0xd8d0bd, 0xe4ddca);
    grid.position.y = -1.25;
    scene.add(grid);

    this.paintAgar();
  }

  // Colour every cell from biome wash, moisture, food and ambient light. Cheap
  // enough to run every few frames so a bloom or a grazing larva shows up.
  paintAgar() {
    const { G, world } = this;
    const biome = world.biome(), moist = world.moisture(), food = world.food();
    const light = world.sim.light_now() / 255;
    const px = this.agarTex.image.data;
    // the lamp carries most of the night; the wash only dims a little so the
    // substrate stays readable at midnight
    const night = 0.88 + 0.12 * light;
    for (let i = 0; i < G * G; i++) {
      const b = biome[i];
      const o = i * 4;
      if (b === BIOME.WALL) { px[o] = 0xf3; px[o + 1] = 0xee; px[o + 2] = 0xe3; px[o + 3] = 255; continue; }
      const w = WASH[b];
      // wet agar reads darker; food reads creamier; the lit patch ignores night
      const m = 1.0 - (moist[i] / 255) * 0.16;
      const f = Math.min(1, Math.max(0, food[i]) / this.foodcap[b]);
      const l = b === BIOME.LIT ? 1.0 : night;
      let r = w[0] * m, g = w[1] * m, bl = w[2] * m;
      if (b === BIOME.YEAST || b === BIOME.AGAR || b === BIOME.RIM) {
        r += (0.99 - r) * f * 0.7; g += (0.97 - g) * f * 0.7; bl += (0.90 - bl) * f * 0.7;
      } else if (b === BIOME.FRUIT) {
        // fruit darkens as it is eaten down
        const d = 0.55 + 0.45 * f;
        r *= d; g *= d; bl *= d;
      }
      px[o] = Math.min(255, r * l * 255);
      px[o + 1] = Math.min(255, g * l * 255);
      px[o + 2] = Math.min(255, bl * l * 255);
      px[o + 3] = 255;
    }
    this.agarTex.needsUpdate = true;
  }

  // ---------- larvae ----------
  buildLarvae() {
    const { RINGS, MAXP, scene } = this;
    this.ringCos = new Float32Array(RADIAL); this.ringSin = new Float32Array(RADIAL);
    for (let s = 0; s < RADIAL; s++) { this.ringCos[s] = Math.cos((s / RADIAL) * TAU); this.ringSin[s] = Math.sin((s / RADIAL) * TAU); }
    const makeTube = (radialN) => {
      const vertCount = RINGS * radialN + 2;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
      const idx = [];
      for (let r = 0; r < RINGS - 1; r++) for (let s = 0; s < radialN; s++) {
        const a = r * radialN + s, b = r * radialN + (s + 1) % radialN;
        const c = (r + 1) * radialN + s, d = (r + 1) * radialN + (s + 1) % radialN;
        idx.push(a, c, b, b, c, d);
      }
      const headV = RINGS * radialN, tailV = RINGS * radialN + 1;
      for (let s = 0; s < radialN; s++) {
        idx.push(headV, s, (s + 1) % radialN);
        idx.push(tailV, (RINGS - 1) * radialN + (s + 1) % radialN, (RINGS - 1) * radialN + s);
      }
      geo.setIndex(idx);
      return geo;
    };
    this.bodies = [];
    const hookGeo = new THREE.ConeGeometry(0.06, 0.22, 6);
    hookGeo.rotateX(Math.PI / 2);
    const hookMat = new THREE.MeshLambertMaterial({ color: INK });
    for (let i = 0; i < MAXP; i++) {
      const skinMat = new THREE.MeshPhysicalMaterial({
        color: 0xf4eee0, transparent: true, opacity: 0.5, roughness: 0.3, metalness: 0,
        clearcoat: 0.6, clearcoatRoughness: 0.4, depthWrite: false,
      });
      const skin = new THREE.Mesh(makeTube(RADIAL), skinMat);
      skin.castShadow = true;
      skin.renderOrder = 2;
      skin.visible = false;
      const gutMat = new THREE.MeshLambertMaterial({ color: AMBER });
      const gut = new THREE.Mesh(makeTube(6), gutMat);
      gut.renderOrder = 1;
      gut.visible = false;
      const hookL = new THREE.Mesh(hookGeo, hookMat), hookR = new THREE.Mesh(hookGeo, hookMat);
      hookL.visible = hookR.visible = false;
      scene.add(skin, gut, hookL, hookR);
      this.bodies.push({ skin, gut, hookL, hookR, energySm: 0 });
    }
    this.pts = Array.from({ length: RINGS }, () => new THREE.Vector3());
    this._t = new THREE.Vector3(); this._n1 = new THREE.Vector3(); this._n2 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._gutColor = new THREE.Color();
    this._gutFull = new THREE.Color(0x8a5314);

    // selection: a leader line from the head, the way a plate points at a specimen
    this.marker = new THREE.Line(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 5, 0]), 3)),
      new THREE.LineBasicMaterial({ color: INK }));
    this.marker.visible = false;
    this.marker.renderOrder = 5;
    scene.add(this.marker);

    // which nodes feed (DN-SEZ): the hooks work when they fire
    this.sezNodes = [];
    this.world.roles.forEach((r, i) => { if (r === 23) this.sezNodes.push(i); });
  }

  writeTube(geo, radialN, pts, radii, scale) {
    const pos = geo.attributes.position.array;
    const t = this._t, n1 = this._n1, n2 = this._n2, RINGS = this.RINGS;
    for (let r = 0; r < RINGS; r++) {
      const p = pts[r];
      t.subVectors(pts[Math.min(RINGS - 1, r + 1)], pts[Math.max(0, r - 1)]).normalize();
      n1.crossVectors(t, this._up);
      if (n1.lengthSq() < 1e-6) n1.set(1, 0, 0); else n1.normalize();
      n2.crossVectors(n1, t).normalize();
      const rad = radii[r] * scale;
      for (let s = 0; s < radialN; s++) {
        const a = (s / radialN) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const o = (r * radialN + s) * 3;
        pos[o] = p.x + (n1.x * ca + n2.x * sa) * rad;
        pos[o + 1] = p.y + (n1.y * ca + n2.y * sa) * rad;
        pos[o + 2] = p.z + (n1.z * ca + n2.z * sa) * rad;
      }
    }
    const headO = RINGS * radialN * 3;
    t.subVectors(pts[0], pts[1]).normalize();
    pos[headO] = pts[0].x + t.x * radii[0] * scale * 1.1;
    pos[headO + 1] = pts[0].y + t.y * radii[0] * scale * 1.1;
    pos[headO + 2] = pts[0].z + t.z * radii[0] * scale * 1.1;
    t.subVectors(pts[RINGS - 1], pts[RINGS - 2]).normalize();
    pos[headO + 3] = pts[RINGS - 1].x + t.x * 0.3;
    pos[headO + 4] = pts[RINGS - 1].y + t.y * 0.3;
    pos[headO + 5] = pts[RINGS - 1].z + t.z * 0.3;
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  // Head at (x, y); the body trails along -heading, each segment turned by
  // its bend. Rings sit on the agar at their own radius.
  layout(i, xs, ys, heads, bends) {
    const { G, NSEG, pts, radii } = this;
    let wx = xs[i] / 65536 - G / 2, wz = ys[i] / 65536 - G / 2;
    const dir0 = (heads[i] / 65536) * TAU;
    pts[0].set(wx, radii[0] + 0.02, wz);
    let dir = dir0;
    for (let s = 0; s < NSEG; s++) {
      dir = dir0 + (bends[i * NSEG + s] / 65536) * TAU;
      wx -= Math.cos(dir) * SEGLEN;
      wz -= Math.sin(dir) * SEGLEN;
      pts[s + 1].set(wx, radii[s + 1] + 0.02, wz);
    }
    wx -= Math.cos(dir) * SEGLEN * 0.7;
    wz -= Math.sin(dir) * SEGLEN * 0.7;
    pts[NSEG + 1].set(wx, radii[NSEG + 1] + 0.02, wz);
    return dir0;
  }

  updateLarvae() {
    const w = this.world;
    const alive = w.alive(), xs = w.xs(), ys = w.ys(), heads = w.headings(), bends = w.bends();
    const energy = w.energy();
    const fired = w.fired();
    const gutRadii = this._gutRadii || (this._gutRadii = this.radii.map(r => r * 0.62));
    for (let i = 0; i < this.MAXP; i++) {
      const b = this.bodies[i];
      if (!alive[i]) {
        if (b.skin.visible) { b.skin.visible = b.gut.visible = b.hookL.visible = b.hookR.visible = false; }
        if (this.selected === i) this.select(-1);
        continue;
      }
      const dir0 = this.layout(i, xs, ys, heads, bends);
      this.writeTube(b.skin.geometry, RADIAL, this.pts, this.radii, 1);
      // the gut: a narrower tube inside, its colour the food inside the animal
      const e = Math.max(0, Math.min(1, energy[i] / 45000));
      b.energySm += (e - b.energySm) * 0.1;
      this._gutColor.setRGB(0.914, 0.886, 0.788).lerp(this._gutFull, Math.pow(b.energySm, 0.7));
      b.gut.material.color.copy(this._gutColor);
      this.writeTube(b.gut.geometry, 6, this.pts, gutRadii, 1);
      // mouth hooks: a dark pair at the anterior tip, spread when DN-SEZ fires
      let sez = 0;
      const base = i * this.world.MAXN;
      for (let k = 0; k < this.sezNodes.length; k++) if (fired[base + this.sezNodes[k]]) sez++;
      const spread = sez ? 0.12 : 0.07;
      const hx = Math.cos(dir0), hz = Math.sin(dir0);
      const px = -hz, pz = hx;
      const head = this.pts[0];
      b.hookL.position.set(head.x + hx * 0.16 + px * spread, 0.10, head.z + hz * 0.16 + pz * spread);
      b.hookR.position.set(head.x + hx * 0.16 - px * spread, 0.10, head.z + hz * 0.16 - pz * spread);
      b.hookL.rotation.y = b.hookR.rotation.y = -dir0 + Math.PI / 2;
      b.skin.visible = b.gut.visible = b.hookL.visible = b.hookR.visible = true;
      if (this.selected === i) {
        const pos = this.marker.geometry.attributes.position;
        pos.setXYZ(0, head.x, head.y + 0.3, head.z);
        pos.setXYZ(1, head.x, head.y + 4.5, head.z);
        pos.needsUpdate = true;
        this.marker.geometry.computeBoundingSphere();
        this.marker.visible = true;
      }
    }
  }

  select(slot) {
    this.selected = slot;
    this.marker.visible = slot >= 0;
    this.onSelect(slot);
  }

  // ---------- light ----------
  updateLight() {
    const l = this.world.sim.light_now() / 255;
    this.lamp.intensity = 0.55 + 0.95 * l;
    this.hemi.intensity = 0.45 + 0.35 * l;
    // the paper goes to a dim brown-grey at night, never black
    this.scene.background.setRGB(0.953 * (0.42 + 0.58 * l), 0.933 * (0.42 + 0.58 * l), 0.890 * (0.42 + 0.58 * l));
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
  }
  pick(px, py, w, h) {
    const wd = this.world;
    const alive = wd.alive(), xs = wd.xs(), ys = wd.ys();
    const v = this._t;
    let best = -1, bestD = 28;
    for (let i = 0; i < this.MAXP; i++) {
      if (!alive[i]) continue;
      v.set(xs[i] / 65536 - this.G / 2, 0.3, ys[i] / 65536 - this.G / 2).project(this.cam);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - px, (-v.y * 0.5 + 0.5) * h - py);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---------- first person: on the agar ----------
  bindFirstPerson() {
    this.fp = { on: false, mode: null, yaw: 0, pitch: -0.1, vx: 0, vz: 0, keys: {}, x: 0, z: 0, fallback: 0 };
    this.savedCam = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this.onFpChange = () => {};
    const canvas = this.canvas;
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === canvas) {
        // a lock granted after the drag fallback already started upgrades
        // the running mode in place: crosshair, hint and centre picking
        clearTimeout(this.fp.fallback);
        this.fp.mode = "locked";
        if (this.fp.on) this.onFpChange(true); else this.enterFP();
      } else if (this.fp.mode === "locked") this.exitFP();
    });
    document.addEventListener("pointerlockerror", () => { clearTimeout(this.fp.fallback); if (!this.fp.on) { this.fp.mode = "drag"; this.enterFP(); } });
    document.addEventListener("mousemove", (e) => {
      if (!this.fp.on) return;
      if (this.fp.mode === "drag" && e.buttons !== 1) return;
      this.fp.yaw -= e.movementX * 0.0026;
      this.fp.pitch = Math.max(-1.4, Math.min(1.4, this.fp.pitch - e.movementY * 0.0024));
    });
    document.addEventListener("keydown", (e) => {
      if (!this.fp.on) return;
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
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
  enterFP() {
    if (this.fp.on) return;
    const fp = this.fp;
    this.savedCam.pos.copy(this.cam.position);
    this.savedCam.target.copy(this.controls.target);
    // start beside the selected larva, or the first living one, looking at it
    const w = this.world;
    const alive = w.alive(), xs = w.xs(), ys = w.ys();
    let tx = 0, tz = 0;
    let slot = this.selected >= 0 && alive[this.selected] ? this.selected : -1;
    if (slot < 0) for (let i = 0; i < this.MAXP; i++) if (alive[i]) { slot = i; break; }
    if (slot >= 0) { tx = xs[slot] / 65536 - this.G / 2; tz = ys[slot] / 65536 - this.G / 2; }
    fp.x = tx + 3; fp.z = tz + 3;
    fp.yaw = Math.atan2(-(tx - fp.x), -(tz - fp.z));
    fp.pitch = -0.25;
    fp.vx = fp.vz = 0;
    fp.on = true;
    this.controls.enabled = false;
    this.onFpChange(true);
  }
  exitFP() {
    const fp = this.fp;
    fp.on = false; fp.mode = null; fp.keys = {};
    this.controls.enabled = true;
    this.cam.position.copy(this.savedCam.pos);
    this.controls.target.copy(this.savedCam.target);
    this.cam.fov = 46; this.cam.updateProjectionMatrix();
    this.onFpChange(false);
  }
  stepFP(dt) {
    const fp = this.fp;
    const k = fp.keys;
    const maxSpeed = k.ShiftLeft ? 9 : 4;
    const s = Math.sin(fp.yaw), c = Math.cos(fp.yaw);
    let mx = 0, mz = 0;
    if (k.KeyW || k.ArrowUp) { mx -= s; mz -= c; }
    if (k.KeyS || k.ArrowDown) { mx += s; mz += c; }
    if (k.KeyA || k.ArrowLeft) { mx -= c; mz += s; }
    if (k.KeyD || k.ArrowRight) { mx += c; mz -= s; }
    const len = Math.hypot(mx, mz) || 1;
    const blend = Math.min(1, dt * 9);
    fp.vx += ((mx / len) * maxSpeed - fp.vx) * blend;
    fp.vz += ((mz / len) * maxSpeed - fp.vz) * blend;
    fp.x += fp.vx * dt; fp.z += fp.vz * dt;
    // the wall is a wall
    const r = Math.hypot(fp.x, fp.z), lim = this.R - 1.2;
    if (r > lim) { fp.x *= lim / r; fp.z *= lim / r; }
    this.cam.position.set(fp.x, 0.9, fp.z);
    this.cam.quaternion.setFromEuler(new THREE.Euler(fp.pitch, fp.yaw, 0, "YXZ"));
    this.cam.fov = 66; this.cam.updateProjectionMatrix();
  }

  // ---------- frame ----------
  render(dt) {
    this.frame++;
    this.updateLight();
    if (this.frame % 4 === 1) this.paintAgar();
    this.updateLarvae();
    if (this.fp.on) this.stepFP(dt); else this.controls.update();
    this.composer.render();
  }
}
