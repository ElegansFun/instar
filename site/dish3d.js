// The dish, drawn. A petri plate on a lab bench, lit like a macro photograph:
// agar built as a 1024-texel substrate (albedo, normal, roughness) from the
// engine's 128-cell grids, yeast colonies as raised mounds, fruit as a wet
// chunk, pools as water, a second lamp over the lit patch, and larvae as
// translucent segmented bodies with a dark gut, mouth hooks, spiracles and a
// slime trail. Pure presentation over the engine's memory; nothing here feeds
// back into the deterministic state.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { EffectComposer } from "./vendor/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "./vendor/jsm/postprocessing/GTAOPass.js";
import { BokehPass } from "./vendor/jsm/postprocessing/BokehPass.js";
import { SMAAPass } from "./vendor/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "./vendor/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "./vendor/jsm/environments/RoomEnvironment.js";
import { BIOME } from "./engine.js";

const INK = 0x141311;
const TAU = Math.PI * 2;
// substrate maps: 1024 texels over the 128-cell grid, built in 64-texel tiles
const TEX = 1024, TILE = 64, TILES = TEX / TILE;
// the agar mesh: a plane grid clamped to the dish circle
const MESH = 448;
// a larva is ~3 cells long: 11 segments of a quarter cell plus head and tail;
// RPS rings per segment so the constrictions curve instead of kinking
const SEGLEN = 0.25;
const RMAX = 0.235;
const RPS = 4;
const RADIAL = 14;
const IDLE_MS = 30000;
// slime fades to 1/e over this many engine ticks
const TRAIL_TICKS = 200;
// the substrate looks for grazed or dried cells this often
const SNAP_TICKS = 40;
// the standing-liquid sheet sits this far below the flat agar surface
const WATER_Y = -0.06;

// ---------- noise ----------
// value noise over a 256-lattice; every substrate feature is a pure function
// of position so a rebuilt tile lands exactly where the previous one was
const NL = 256;
const lattice = new Float32Array(NL * NL);
{
  let s = 0x2545f491;
  for (let i = 0; i < NL * NL; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; lattice[i] = s / 4294967296; }
}
function vn(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = xi & 255, x1 = (xi + 1) & 255, y0 = (yi & 255) << 8, y1 = ((yi + 1) & 255) << 8;
  const a = lattice[y0 + x0], b = lattice[y0 + x1], c = lattice[y1 + x0], d = lattice[y1 + x1];
  const t = a + (b - a) * ux;
  return t + ((c + (d - c) * ux) - t) * uy;
}
const fbm2 = (x, y) => vn(x, y) * 0.667 + vn(x * 2.03 + 31.7, y * 2.03 + 17.1) * 0.333;
function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}
// distance between the nearest two jittered lattice points: thin where a
// crack runs between crust plates
function worleyEdge(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const h = hash2(xi + dx, yi + dy);
    const px = xi + dx + (h & 255) / 255, py = yi + dy + ((h >>> 8) & 255) / 255;
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------- the substrate ----------
// Albedo, normal and roughness/ao/sheen maps at 1024², plus vertex heights for
// the agar mesh, all from one field function over the engine's biome,
// moisture and food grids. A sweep rebuilds only the tiles whose cells
// changed since the last snapshot, inside a per-frame time budget; the GPU
// copies land once per completed sweep.
class Substrate {
  constructor(world, foodcap) {
    this.world = world;
    this.G = world.G; this.R = world.R;
    this.HALF = this.R + 1;
    this.step = (2 * this.HALF) / MESH;
    this.foodcap = foodcap;
    const G = this.G;
    this.cellB = new Uint8Array(G * G);
    this.cellM = new Float32Array(G * G);
    this.cellF = new Float32Array(G * G);
    this.albedo = new Uint8Array(TEX * TEX * 4);
    this.normal = new Uint8Array(TEX * TEX * 4);
    this.orm = new Uint8Array(TEX * TEX * 4);
    this.hgrid = new Float32Array((MESH + 1) * (MESH + 1));
    this.scratch = new Float32Array((TILE + 2) * (TILE + 2));
    this.out = new Float32Array(7); // h r g b rough ao sheen
    this.dirty = new Uint8Array(TILES * TILES).fill(1);
    this.tile = 0;
    this.built = 0;
    this.sweeps = 0;
    this.snapTick = 0;
    this.snapshot();
  }
  // Copy the grids; a cell whose class, moisture or food moved by more than
  // a texel's worth marks its tile and the neighbours the domain warp
  // reaches into.
  snapshot() {
    const w = this.world, G = this.G, dirty = this.dirty;
    const biome = w.biome(), moist = w.moisture(), food = w.food();
    const cellB = this.cellB, cellM = this.cellM, cellF = this.cellF;
    const per = G / TILES; // cells per tile
    for (let i = 0; i < G * G; i++) {
      const b = biome[i], m = moist[i] / 255, f = clamp01(food[i] / this.foodcap[b]);
      if (b === cellB[i] && Math.abs(m - cellM[i]) < 0.04 && Math.abs(f - cellF[i]) < 0.05) continue;
      cellB[i] = b; cellM[i] = m; cellF[i] = f;
      const cx = i % G, cz = Math.floor(i / G);
      const tx = Math.floor(cx / per), tz = Math.floor(cz / per);
      // the warp reaches about a cell and a half, so a change within two
      // cells of a tile border shows in the next tile too
      const x0 = cx % per <= 1 && tx > 0 ? tx - 1 : tx, x1 = cx % per >= per - 2 && tx < TILES - 1 ? tx + 1 : tx;
      const z0 = cz % per <= 1 && tz > 0 ? tz - 1 : tz, z1 = cz % per >= per - 2 && tz < TILES - 1 ? tz + 1 : tz;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) dirty[z * TILES + x] = 1;
    }
  }
  // the field at grid coordinates (cell i spans [i, i+1))
  sample(gx, gz) {
    const G = this.G, o = this.out;
    const cellB = this.cellB, cellM = this.cellM, cellF = this.cellF;
    // domain warp so class edges wander instead of stepping cell by cell:
    // a broad octave bends them, a fine one frays them
    const wx = gx + (fbm2(gx * 0.7 + 11.3, gz * 0.7 + 5.1) - 0.5) * 1.3 + (vn(gx * 2.6 + 3.7, gz * 2.6 + 1.9) - 0.5) * 0.4;
    const wz = gz + (fbm2(gx * 0.7 + 97.7, gz * 0.7 + 41.9) - 0.5) * 1.3 + (vn(gx * 2.6 + 55.1, gz * 2.6 + 23.3) - 0.5) * 0.4;
    const cx = wx - 0.5, cz = wz - 0.5;
    let i0 = Math.floor(cx), j0 = Math.floor(cz);
    let fx = cx - i0, fz = cz - j0;
    if (i0 < 0) { i0 = 0; fx = 0; } else if (i0 > G - 2) { i0 = G - 2; fx = 1; }
    if (j0 < 0) { j0 = 0; fz = 0; } else if (j0 > G - 2) { j0 = G - 2; fz = 1; }
    const c00 = j0 * G + i0, c10 = c00 + 1, c01 = c00 + G, c11 = c01 + 1;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    let wY = 0, wF = 0, wP = 0, wD = 0;
    let b = cellB[c00]; if (b === 2) wY += w00; else if (b === 3) wF += w00; else if (b === 5) wP += w00; else if (b === 4) wD += w00;
    b = cellB[c10]; if (b === 2) wY += w10; else if (b === 3) wF += w10; else if (b === 5) wP += w10; else if (b === 4) wD += w10;
    b = cellB[c01]; if (b === 2) wY += w01; else if (b === 3) wF += w01; else if (b === 5) wP += w01; else if (b === 4) wD += w01;
    b = cellB[c11]; if (b === 2) wY += w11; else if (b === 3) wF += w11; else if (b === 5) wP += w11; else if (b === 4) wD += w11;
    const m = cellM[c00] * w00 + cellM[c10] * w10 + cellM[c01] * w01 + cellM[c11] * w11;
    const f = cellF[c00] * w00 + cellF[c10] * w10 + cellF[c01] * w01 + cellF[c11] * w11;

    const n1 = fbm2(gx * 3.1, gz * 3.1);            // fine grain
    const nm = vn(gx * 1.4 + 13.1, gz * 1.4 + 71.7);  // mid-scale wander
    const n2 = vn(gx * 0.33 + 7.7, gz * 0.33 + 3.3);  // broad mottling
    const ng = fbm2(gx * 2.1 + 2.2, gz * 2.1 + 9.9);  // colony granules

    // agar: amber-grey, darker and glossier where wet, faintly mottled
    const wet = m * 0.8;
    const mot = (0.95 + 0.1 * n2) * (0.985 + 0.03 * n1);
    let r = (0.74 - 0.20 * wet) * mot, g = (0.66 - 0.20 * wet) * mot, bl = (0.49 - 0.16 * wet) * mot;
    let rough = 0.78 - 0.38 * m;
    let h = (n1 - 0.5) * 0.012;
    let ao = 1, sheen = 0;

    // deposits on plain agar: a thin creamy film
    const yeast = smooth(0.32, 0.68, wY + (nm - 0.5) * 0.35);
    const fruit = smooth(0.4, 0.6, wF + (nm - 0.5) * 0.25);
    const pool = smooth(0.3, 0.7, wP + (nm - 0.5) * 0.2);
    const dry = smooth(0.3, 0.7, wD + (n2 - 0.5) * 0.4 + (nm - 0.5) * 0.2);
    const film = f * (1 - yeast) * (1 - fruit) * (1 - pool) * 0.45;
    if (film > 0) { r += (0.88 - r) * film; g += (0.82 - g) * film; bl += (0.66 - bl) * film; }

    // dry crust: matte, cracked into plates
    if (dry > 0.02) {
      const edge = worleyEdge(gx * 1.15 + 3.1, gz * 1.15 + 8.8);
      const crack = 1 - smooth(0.02, 0.09, edge);
      const shade = 1 - 0.45 * crack;
      const k = dry;
      r += ((0.88 * shade) - r) * k; g += ((0.85 * shade) - g) * k; bl += ((0.74 * shade) - bl) * k;
      rough += (0.93 - rough) * k;
      h -= 0.05 * crack * k;
      ao -= 0.35 * crack * k;
    }
    // yeast: a raised granular mound that goes back to bare agar as it is grazed
    if (yeast > 0.001) {
      const mass = yeast * (0.15 + 0.85 * f);
      const cream = 0.92 + 0.07 * ng + 0.02 * n1;
      r += (cream - r) * mass; g += (cream * 0.95 - g) * mass; bl += (cream * 0.80 - bl) * mass;
      rough += (0.62 - rough) * mass;
      h += 0.34 * yeast * f * (0.7 + 0.45 * ng + 0.1 * n1) + 0.05 * yeast * f * (vn(gx * 4.1 + 9.2, gz * 4.1 + 4.4) - 0.5);
      sheen = mass;
      ao -= 0.12 * yeast * (1 - f);
    }
    // fruit stain: juice under and around the chunk, browning as the food goes
    if (fruit > 0.001) {
      const fresh = f;
      const fr = 0.30 + 0.22 * fresh, fg = 0.17 + 0.14 * fresh, fb = 0.08 + 0.07 * fresh;
      r += (fr - r) * fruit; g += (fg - g) * fruit; bl += (fb - bl) * fruit;
      rough += (0.28 - rough) * fruit;
      h += 0.04 * fruit;
    }
    // pools: the agar dips under standing liquid; a wet margin rings it
    if (pool > 0.001) {
      const margin = clamp01(pool * 3) * (1 - pool);
      const k = 0.5;
      r *= 1 - (1 - k) * pool - 0.15 * margin; g *= 1 - (1 - k * 1.06) * pool - 0.15 * margin; bl *= 1 - (1 - k * 1.14) * pool - 0.13 * margin;
      rough += (0.22 - rough) * clamp01(pool * 3);
      // the bed dips; the meniscus lifts a thin lip at the waterline
      h -= 0.34 * pool - 0.05 * Math.max(0, 1 - Math.abs(pool - 0.22) * 6);
      ao -= 0.2 * margin;
    }
    // the meniscus: agar climbs the wall
    const dx = gx - G / 2, dz = gz - G / 2;
    const rr = Math.sqrt(dx * dx + dz * dz);
    const men = smooth(this.R - 3, this.R, rr);
    h += 0.3 * men * men;

    o[0] = h; o[1] = r; o[2] = g; o[3] = bl; o[4] = rough; o[5] = ao; o[6] = sheen;
  }
  buildTile(k) {
    const tx0 = (k % TILES) * TILE, tz0 = Math.floor(k / TILES) * TILE;
    const G = this.G, o = this.out, sc = this.scratch, W = TILE + 2;
    const tex = G / TEX;
    const alb = this.albedo, nrm = this.normal, orm = this.orm;
    // heights with a one-texel apron, then colour, then normals from the apron
    for (let j = 0; j < W; j++) {
      const gz = (tz0 + j - 0.5) * tex;
      for (let i = 0; i < W; i++) {
        const gx = (tx0 + i - 0.5) * tex;
        this.sample(gx, gz);
        sc[j * W + i] = o[0];
        if (i === 0 || j === 0 || i === W - 1 || j === W - 1) continue;
        const p = ((tz0 + j - 1) * TEX + (tx0 + i - 1)) * 4;
        alb[p] = o[1] * 255; alb[p + 1] = o[2] * 255; alb[p + 2] = o[3] * 255; alb[p + 3] = 255;
        orm[p] = clamp01(o[5]) * 255; orm[p + 1] = clamp01(o[4]) * 255; orm[p + 2] = clamp01(o[6]) * 255; orm[p + 3] = 255;
      }
    }
    const inv = 1 / (2 * tex);
    for (let j = 1; j <= TILE; j++) for (let i = 1; i <= TILE; i++) {
      const dhx = (sc[j * W + i + 1] - sc[j * W + i - 1]) * inv;
      const dhz = (sc[(j + 1) * W + i] - sc[(j - 1) * W + i]) * inv;
      const len = Math.sqrt(dhx * dhx + dhz * dhz + 1);
      const p = ((tz0 + j - 1) * TEX + (tx0 + i - 1)) * 4;
      nrm[p] = (0.5 - 0.5 * dhx / len) * 255;
      nrm[p + 1] = (0.5 - 0.5 * dhz / len) * 255;
      nrm[p + 2] = (0.5 + 0.5 / len) * 255;
      nrm[p + 3] = 255;
    }
    // vertex heights for the mesh vertices that fall inside this tile
    const step = this.step, HALF = this.HALF;
    const gxa = tx0 * tex, gxb = (tx0 + TILE) * tex, gza = tz0 * tex, gzb = (tz0 + TILE) * tex;
    const ia = Math.max(0, Math.ceil((gxa - G / 2 + HALF) / step)), ib = Math.min(MESH, Math.ceil((gxb - G / 2 + HALF) / step) - 1);
    const ja = Math.max(0, Math.ceil((gza - G / 2 + HALF) / step)), jb = Math.min(MESH, Math.ceil((gzb - G / 2 + HALF) / step) - 1);
    const pos = this.positions;
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
      const v = j * (MESH + 1) + i;
      this.sample(pos[v * 3] + G / 2, pos[v * 3 + 2] + G / 2);
      this.hgrid[v] = o[0];
      pos[v * 3 + 1] = o[0];
    }
  }
  // build dirty tiles until the deadline; true once a sweep that rebuilt
  // something has landed
  sweep(deadline) {
    const dirty = this.dirty;
    while (this.tile < TILES * TILES) {
      const k = this.tile++;
      if (!dirty[k]) continue;
      dirty[k] = 0;
      this.built++;
      this.buildTile(k);
      if (performance.now() > deadline) break;
    }
    if (this.tile < TILES * TILES) return false;
    this.tile = 0;
    const done = this.built > 0;
    if (done) { this.sweeps++; this.built = 0; }
    // grazing is slow; look for changes a couple of seconds apart
    const tick = this.world.tick();
    if (tick - this.snapTick >= SNAP_TICKS || tick < this.snapTick) { this.snapTick = tick; this.snapshot(); }
    return done;
  }
  heightAt(x, z) {
    const fi = (x + this.HALF) / this.step, fj = (z + this.HALF) / this.step;
    let i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0) i0 = 0; else if (i0 > MESH - 1) i0 = MESH - 1;
    if (j0 < 0) j0 = 0; else if (j0 > MESH - 1) j0 = MESH - 1;
    const fx = clamp01(fi - i0), fz = clamp01(fj - j0);
    const h = this.hgrid, s = MESH + 1, a = j0 * s + i0;
    const t = h[a] + (h[a + 1] - h[a]) * fx;
    return t + ((h[a + s] + (h[a + s + 1] - h[a + s]) * fx) - t) * fz;
  }
}

// GTAO with the glass and the water left out of its normal/depth pass: what
// is seen through them should shade the agar, not the pane.
class DishGTAO extends GTAOPass {
  constructor(excluded, ...args) { super(...args); this.excluded = excluded; }
  _overrideVisibility() {
    super._overrideVisibility();
    for (const o of this.excluded) if (o.visible) { o.visible = false; this._visibilityCache.push(o); }
  }
  // AO at half resolution: cheap on an integrated GPU, soft by nature
  setSize(w, h) { super.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); }
}

export class Dish3D {
  constructor(canvas, world, { embedded = false, onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.world = world;
    this.onSelect = onSelect;
    this.embedded = embedded;
    this.selected = -1;
    this.tracking = -1;
    this.frame = 0;
    this.lastInput = performance.now();
    const s = world.sim;
    this.G = world.G; this.R = world.R; this.NSEG = world.NSEG; this.MAXP = world.MAXP;
    this.NR = RPS * this.NSEG + 1;
    this.foodcap = [];
    for (let b = 0; b < 8; b++) this.foodcap[b] = Math.max(1, s.biome_foodcap(b));

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.transmissionResolutionScale = 0.5;

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0xc9c3b4);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // default view: three-quarter from the front, 34 degrees up; the
    // distance is fitted to the canvas in resize() until the user takes over
    const cam = this.cam = new THREE.PerspectiveCamera(38, 1, 0.5, 800);
    cam.position.set(30, 112, 160);
    const controls = this.controls = new OrbitControls(cam, canvas);
    controls.target.set(0, 3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = 1.45;
    controls.minDistance = 4;
    controls.maxDistance = 420;
    controls.enableZoom = !embedded;
    controls.enablePan = !embedded;
    controls.autoRotateSpeed = 0.35;
    this.userMoved = false;
    const touched = () => { this.lastInput = performance.now(); this.userMoved = true; this.controls.autoRotate = false; };
    for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) canvas.addEventListener(ev, touched, { passive: true });

    // the key lamp: over the far side of the bench so the plate is backlit
    // the way a macro shot is; the day/night of the engine moves its
    // strength and colour. Its shadow frustum follows the orbit target and
    // shrinks as the camera closes in, so close-ups get crisp shadows.
    const lamp = this.lamp = new THREE.DirectionalLight(0xfff3e2, 2.4);
    this.lampDir = new THREE.Vector3(-46, 128, -58).normalize();
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.camera.near = 20; lamp.shadow.camera.far = 320;
    lamp.shadow.radius = 2;
    scene.add(lamp);
    scene.add(lamp.target);
    this.shadowHalf = 0;
    this.fitShadow(0, 0, 0, 64);
    this.fill = new THREE.HemisphereLight(0xe8eef6, 0x8a806c, 0.35);
    scene.add(this.fill);

    this.sub = new Substrate(world, this.foodcap);
    this.buildBench();
    this.buildDish();
    this.buildFeatures();
    this.buildLarvae();
    this.buildTrail();

    const composer = this.composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));
    const gtao = this.gtao = new DishGTAO(this.aoExcluded, scene, cam, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1, thickness: 1, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
    gtao.blendIntensity = 0.85;
    composer.addPass(gtao);
    const bokeh = this.bokeh = new BokehPass(scene, cam, { focus: 3.2, aperture: 0.012, maxblur: 0.006 });
    bokeh.enabled = false;
    composer.addPass(bokeh);
    composer.addPass(new SMAAPass());
    composer.addPass(new OutputPass());

    this.bindPicking();
    this.bindFirstPerson();
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    this.resize();
    // the first substrate build is synchronous so the plate is never blank;
    // a DataTexture only uploads once flagged, so the flags land here rather
    // than one per frame
    this.uploads = [];
    this.sub.positions = this.agar.geometry.attributes.position.array;
    while (!this.sub.sweep(Infinity));
    this.commitSubstrate();
    while (this.uploads.length) this.uploads.shift()();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const cam = this.cam, aspect = w / h;
    cam.aspect = aspect;
    // a portrait canvas opens the field of view rather than backing off
    if (!this.fp.on) cam.fov = aspect >= 1.2 ? 38 : Math.min(60, 2 * Math.atan(Math.tan(19 * Math.PI / 180) * 1.2 / aspect) * 180 / Math.PI);
    cam.updateProjectionMatrix();
    this.bokeh.uniforms.aspect.value = aspect;
    if (this.userMoved || this.fp.on) return;
    // fit the plate: its projected half-height at 34 degrees is about
    // 0.56 R plus the far rim; its half-width is the rim radius
    const R = this.R + 4;
    const tv = Math.tan(cam.fov * Math.PI / 360), th = tv * aspect;
    const d = Math.max((0.56 * R + 12) / tv, R / th) * (this.embedded ? 1.12 : aspect < 1.2 ? 1.15 : 1.3);
    const c = this.controls;
    cam.position.sub(c.target).normalize().multiplyScalar(d).add(c.target);
  }

  // ---------- the bench ----------
  buildBench() {
    const { scene, R } = this;
    // matte lab paper with a faint millimetre grid
    const cv = document.createElement("canvas");
    cv.width = cv.height = 512;
    const c = cv.getContext("2d");
    c.fillStyle = "#cbc6b9"; c.fillRect(0, 0, 512, 512);
    const img = c.getImageData(0, 0, 512, 512), d = img.data;
    for (let i = 0; i < 512 * 512; i++) {
      const g = (vn((i % 512) * 0.9, Math.floor(i / 512) * 0.9) - 0.5) * 14 + (hash2(i, 7) & 7) - 3.5;
      d[i * 4] += g; d[i * 4 + 1] += g; d[i * 4 + 2] += g;
    }
    c.putImageData(img, 0, 0);
    c.strokeStyle = "rgba(90,80,60,0.13)"; c.lineWidth = 1;
    for (let k = 0; k < 512; k += 64) { c.beginPath(); c.moveTo(k + 0.5, 0); c.lineTo(k + 0.5, 512); c.moveTo(0, k + 0.5); c.lineTo(512, k + 0.5); c.stroke(); }
    const paper = new THREE.CanvasTexture(cv);
    paper.wrapS = paper.wrapT = THREE.RepeatWrapping;
    paper.repeat.set(48, 48);
    paper.anisotropy = 8;
    paper.colorSpace = THREE.SRGBColorSpace;
    const bench = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ map: paper, roughness: 0.96, metalness: 0 }));
    bench.rotation.x = -Math.PI / 2;
    bench.position.y = -5.2;
    bench.receiveShadow = true;
    scene.add(bench);

    // the dish's contact shadow: a soft dark ring where the foot meets the paper
    const rc = document.createElement("canvas");
    rc.width = rc.height = 256;
    const g2 = rc.getContext("2d");
    const grad = g2.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0.0, "rgba(0,0,0,0.30)");
    grad.addColorStop(0.86, "rgba(0,0,0,0.42)");
    grad.addColorStop(0.93, "rgba(0,0,0,0.18)");
    grad.addColorStop(1.0, "rgba(0,0,0,0)");
    g2.fillStyle = grad; g2.fillRect(0, 0, 256, 256);
    const contact = new THREE.Mesh(new THREE.PlaneGeometry((R + 5) * 2, (R + 5) * 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(rc), transparent: true, depthWrite: false, color: 0x2a2620 }));
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = -5.18;
    contact.renderOrder = -1;
    scene.add(contact);
    this.aoExcluded = [contact];
  }

  // ---------- the plate ----------
  buildDish() {
    const { G, R, scene, sub } = this;
    const HALF = sub.HALF;
    // the agar: a dense grid clamped to the circle, heights from the substrate
    const N = MESH + 1;
    const pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), nor = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let x = -HALF + i * sub.step, z = -HALF + j * sub.step;
      const r = Math.hypot(x, z);
      if (r > R) { x *= R / r; z *= R / r; }
      const v = j * N + i;
      pos[v * 3] = x; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = z;
      nor[v * 3 + 1] = 1;
      uv[v * 2] = (x + G / 2) / G; uv[v * 2 + 1] = (z + G / 2) / G;
    }
    const idx = new Uint32Array(MESH * MESH * 6);
    let q = 0;
    for (let j = 0; j < MESH; j++) for (let i = 0; i < MESH; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R + 2);

    const mk = (data, srgb) => {
      const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      t.flipY = false;
      return t;
    };
    this.albedoTex = mk(sub.albedo, true);
    this.normalTex = mk(sub.normal, false);
    this.ormTex = mk(sub.orm, false);
    const agarMat = this.agarMat = new THREE.MeshPhysicalMaterial({
      map: this.albedoTex, normalMap: this.normalTex, normalScale: new THREE.Vector2(1, 1),
      roughnessMap: this.ormTex, aoMap: this.ormTex, aoMapIntensity: 1, roughness: 1, metalness: 0,
      clearcoat: 0.25, clearcoatRoughness: 0.5, sheen: 0.8, sheenColor: new THREE.Color(0xfff4d6), sheenRoughness: 0.6,
      envMapIntensity: 0.9,
    });
    // the slime trail and the yeast sheen mask are read from our own maps
    agarMat.onBeforeCompile = (sh) => {
      sh.uniforms.trailMap = { value: this.trailRT.texture };
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <roughnessmap_pars_fragment>", "#include <roughnessmap_pars_fragment>\nuniform sampler2D trailMap;")
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nfloat slime = clamp(texture2D(trailMap, vMapUv).r, 0.0, 1.0);\nroughnessFactor = mix(roughnessFactor, 0.14, slime);\ndiffuseColor.rgb *= 1.0 - 0.07 * slime;")
        .replace("material.sheenColor = sheenColor;", "material.sheenColor = sheenColor * texelRoughness.b;");
    };
    const agar = this.agar = new THREE.Mesh(geo, agarMat);
    agar.receiveShadow = true;
    scene.add(agar);

    // the slab's side, seen through the wall
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 4.9, 160, 1, true),
      new THREE.MeshPhysicalMaterial({ color: 0xb8a684, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }));
    slab.position.y = -4.6 + 2.45;
    slab.castShadow = true;
    scene.add(slab);
    // the slab's floor closes the meniscus rim from below
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.MeshPhysicalMaterial({ color: 0xa89876, roughness: 0.7 }));
    floor.rotation.x = Math.PI / 2;
    floor.position.y = -4.6;
    floor.castShadow = true;
    scene.add(floor);

    // standing liquid: one reflective, refracting sheet just under the agar
    // surface; it shows only where the substrate dips into a pool
    const water = this.water = new THREE.Mesh(new THREE.CircleGeometry(R - 0.5, 128), new THREE.MeshPhysicalMaterial({
      color: 0xe6ecea, roughness: 0.06, metalness: 0, transmission: 0.9, ior: 1.33, thickness: 0.4,
      attenuationColor: new THREE.Color(0xa3b09c), attenuationDistance: 3, envMapIntensity: 9, specularIntensity: 1,
    }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    water.receiveShadow = true;
    scene.add(water);
    this.aoExcluded.push(water);

    // the dish: clear polystyrene, refracting what is behind it; the wall is
    // DoubleSide so the far wall is seen through the near one
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.04, metalness: 0, ior: 1.49, transmission: 1, thickness: 0.8,
      specularIntensity: 1, envMapIntensity: 2.6, side: THREE.DoubleSide,
    });
    const WR = R + 1.6;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(WR, WR, 19.6, 160, 1, true), glass);
    wall.position.y = -5.2 + 9.8;
    wall.renderOrder = 6;
    scene.add(wall);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(WR, WR, 0.6, 160), glass);
    base.position.y = -4.9;
    base.renderOrder = 5;
    scene.add(base);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(WR, 0.55, 10, 200), glass);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 14.4;
    rim.renderOrder = 7;
    scene.add(rim);
    const foot = new THREE.Mesh(new THREE.TorusGeometry(WR - 0.3, 0.35, 8, 200),
      new THREE.MeshPhysicalMaterial({ color: 0xdfe3df, roughness: 0.35, transparent: true, opacity: 0.6, depthWrite: false }));
    foot.rotation.x = Math.PI / 2;
    foot.position.y = -5.05;
    foot.renderOrder = 5;
    scene.add(foot);
    // the lid, set down upside-down behind the plate: same polystyrene, but
    // its flat top faces the ceiling, so it takes a quieter reflection
    const lidGlass = glass.clone();
    lidGlass.envMapIntensity = 0.9;
    lidGlass.roughness = 0.1;
    const lid = new THREE.Group();
    const lidWall = new THREE.Mesh(new THREE.CylinderGeometry(WR + 1.4, WR + 1.4, 8, 160, 1, true), lidGlass);
    lidWall.position.y = 4;
    const lidTop = new THREE.Mesh(new THREE.CylinderGeometry(WR + 1.4, WR + 1.4, 0.6, 160), lidGlass);
    lidTop.position.y = 0.3;
    lidWall.renderOrder = lidTop.renderOrder = 6;
    lid.add(lidWall, lidTop);
    lid.position.set(-(2 * R + 34), -5.2, -70);
    scene.add(lid);
    this.aoExcluded.push(wall, base, rim, foot, lidWall, lidTop);
  }

  // Yeast colonies live in the substrate maps; fruit is a chunk that sits on
  // the agar, and the lit patch has its own lamp with a visible cone.
  buildFeatures() {
    const { G, R, scene, world } = this;
    const biome = world.biome();
    // connected fruit pieces and the lit patch centroid, from the fixed genesis layout
    const seen = new Uint8Array(G * G);
    const pieces = [];
    let litX = 0, litZ = 0, litN = 0;
    for (let c = 0; c < G * G; c++) {
      if (biome[c] === BIOME.LIT) { litX += c % G + 0.5; litZ += Math.floor(c / G) + 0.5; litN++; }
      if (biome[c] !== BIOME.FRUIT || seen[c]) continue;
      const cells = [], stack = [c];
      seen[c] = 1;
      while (stack.length) {
        const k = stack.pop();
        cells.push(k);
        const x = k % G, y = Math.floor(k / G);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          const n = ny * G + nx;
          if (biome[n] === BIOME.FRUIT && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      let sx = 0, sz = 0;
      for (const k of cells) { sx += k % G + 0.5; sz += Math.floor(k / G) + 0.5; }
      pieces.push({ cells, x: sx / cells.length - G / 2, z: sz / cells.length - G / 2, rad: Math.sqrt(cells.length / Math.PI) });
    }
    this.fruit = [];
    const _c = new THREE.Color(), ca = new THREE.Color(0xa2582c), cb = new THREE.Color(0x4a2a12);
    pieces.forEach((p, n) => {
      // an indexed sphere so the displaced surface keeps smooth normals
      const geo = new THREE.SphereGeometry(1, 72, 48);
      const v = geo.attributes.position, col = new Float32Array(v.count * 3);
      for (let i = 0; i < v.count; i++) {
        const x = v.getX(i), y = v.getY(i), z = v.getZ(i);
        const lump = (fbm2(x * 2.4 + n * 9 + 5, z * 2.4 + y * 1.7) - 0.5) * 0.32;
        const grain = (vn(x * 9 + y * 5 + n * 3, z * 9 - y * 4) - 0.5) * 0.05;
        const bump = 1 + lump + grain - 0.05 * Math.max(0, -y);
        v.setXYZ(i, x * bump, Math.max(-0.35, y) * bump * 0.55 + 0.2, z * bump);
        const patch = smooth(0.5, 0.75, vn(x * 3.3 + n * 4, z * 3.3 + y * 2 + 8));
        _c.copy(ca).lerp(cb, patch).multiplyScalar(0.92 + 0.16 * vn(x * 14 + n, z * 14 + y * 7));
        col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.22, sheen: 0.25, sheenColor: new THREE.Color(0xd9a06a) });
      const mesh = new THREE.Mesh(geo, mat);
      const s = p.rad * 0.92;
      mesh.scale.set(s, s, s);
      mesh.rotation.y = n * 1.9;
      mesh.position.set(p.x, 0.02, p.z);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      this.fruit.push({ mesh, cells: p.cells });
    });

    // the second lamp: a spot over the lit patch, and the cone it throws
    if (litN) {
      const lx = litX / litN - G / 2, lz = litZ / litN - G / 2;
      const H = 46;
      const spot = this.spot = new THREE.SpotLight(0xfff6e0, 1500, 0, Math.atan(11 / H), 0.55, 2);
      spot.position.set(lx + 6, H, lz - 4);
      spot.target.position.set(lx, 0, lz);
      scene.add(spot, spot.target);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, 3.2, 32, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x2b2926, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }));
      head.position.copy(spot.position).y += 1.4;
      head.lookAt(spot.target.position);
      head.rotateX(Math.PI / 2);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 120, 12), new THREE.MeshStandardMaterial({ color: 0x3a3733, roughness: 0.4, metalness: 0.7 }));
      stem.position.copy(spot.position).y += 62;
      scene.add(head, stem);
      const cv = document.createElement("canvas");
      cv.width = 4; cv.height = 128;
      const g = cv.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, "rgba(255,255,255,0.30)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.12)");
      grad.addColorStop(1, "rgba(255,255,255,0.04)");
      g.fillStyle = grad; g.fillRect(0, 0, 4, 128);
      const coneTex = new THREE.CanvasTexture(cv);
      const cone = this.cone = new THREE.Mesh(new THREE.ConeGeometry(11.5, H, 48, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff2d2, alphaMap: coneTex, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide }));
      cone.position.set((lx + spot.position.x) / 2, H / 2, (lz + spot.position.z) / 2);
      cone.lookAt(spot.position);
      cone.rotateX(Math.PI / 2);
      cone.renderOrder = 8;
      scene.add(cone);
      this.aoExcluded.push(cone, head, stem);
    }
  }

  // ---------- larvae ----------
  buildLarvae() {
    const { NR, NSEG, MAXP, scene } = this;
    // fusiform profile: blunt head, fat mid-abdomen, pointed tail; each
    // segment boundary is a smooth pinch
    this.profile = new Float32Array(NR);
    for (let r = 0; r < NR; r++) {
      const u = r / (NR - 1);
      let p = 0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.97));
      if (u > 0.85) p *= 1 - 0.6 * ((u - 0.85) / 0.15) ** 2;
      if (r > 0 && r < NR - 1) p *= 1 - 0.045 * (1 + Math.cos(TAU * (r % RPS) / RPS));
      this.profile[r] = p * RMAX;
    }
    this._cs = {};
    const makeTube = (radialN) => {
      const W = radialN + 1;
      const vertCount = NR * W + 2;
      if (!this._cs[radialN]) {
        const cs = this._cs[radialN] = new Float32Array(W * 2);
        for (let s = 0; s <= radialN; s++) { cs[s * 2] = Math.cos((s / radialN) * TAU); cs[s * 2 + 1] = Math.sin((s / radialN) * TAU); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
      const uv = new Float32Array(vertCount * 2);
      for (let r = 0; r < NR; r++) for (let s = 0; s < W; s++) { uv[(r * W + s) * 2] = s / radialN; uv[(r * W + s) * 2 + 1] = r / (NR - 1); }
      uv[(NR * W) * 2] = 0.5; uv[(NR * W) * 2 + 1] = 0;
      uv[(NR * W + 1) * 2] = 0.5; uv[(NR * W + 1) * 2 + 1] = 1;
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      const idx = [];
      for (let r = 0; r < NR - 1; r++) for (let s = 0; s < radialN; s++) {
        const a = r * W + s, b = a + 1, c = (r + 1) * W + s, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const headV = NR * W, tailV = NR * W + 1;
      for (let s = 0; s < radialN; s++) {
        idx.push(headV, s, s + 1);
        idx.push(tailV, (NR - 1) * W + s + 1, (NR - 1) * W + s);
      }
      geo.setIndex(idx);
      return geo;
    };
    const skinTex = this.skinTexture();
    // One cuticle material for every body, opaque so the animal lands in
    // the transmission buffer and stays visible through the dish wall and
    // under pool water. The gut is drawn by the shader: a dark band down
    // the middle of the tube from whichever side it is seen (where the
    // normal faces the eye), its colour and width per animal through two
    // uniforms set before each draw; a rim term gives the cuticle its
    // translucent look.
    const gutU = this.gutU = { gutColor: { value: new THREE.Color() }, gutEdge: { value: 0.9 } };
    const skinMat = new THREE.MeshPhysicalMaterial({
      map: skinTex, color: 0xfbf7ef, roughness: 0.38, metalness: 0,
      clearcoat: 0.5, clearcoatRoughness: 0.35, envMapIntensity: 0.8,
    });
    skinMat.onBeforeCompile = (sh) => {
      sh.uniforms.gutColor = gutU.gutColor;
      sh.uniforms.gutEdge = gutU.gutEdge;
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform vec3 gutColor;\nuniform float gutEdge;")
        .replace("#include <map_fragment>", "#include <map_fragment>\n{\n" +
          "float nv = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);\n" +
          "float band = smoothstep(gutEdge - 0.1, gutEdge + 0.08, nv);\n" +
          "float along = smoothstep(0.1, 0.24, vMapUv.y) * (1.0 - smoothstep(0.84, 0.96, vMapUv.y));\n" +
          "diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * gutColor, band * along * 0.85);\n" +
          "diffuseColor.rgb += vec3(0.12, 0.11, 0.09) * pow(1.0 - nv, 3.0);\n}");
    };
    this.bodies = [];
    for (let i = 0; i < MAXP; i++) {
      const skin = new THREE.Mesh(makeTube(RADIAL), skinMat);
      skin.castShadow = skin.receiveShadow = true;
      skin.frustumCulled = false;
      skin.visible = false;
      const b = { skin, uid: -1, fill: 0, diet: 0, lastEnergy: 0, gutColor: new THREE.Color(), gutEdge: 0.9 };
      skin.onBeforeRender = () => { gutU.gutColor.value.copy(b.gutColor); gutU.gutEdge.value = b.gutEdge; };
      scene.add(skin);
      this.bodies.push(b);
    }
    // mouth hooks and posterior spiracles: one instanced draw each
    const hookGeo = new THREE.ConeGeometry(0.028, 0.13, 6);
    hookGeo.rotateX(Math.PI / 2);
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.4, metalness: 0.1 });
    this.hooks = new THREE.InstancedMesh(hookGeo, dark, 2 * MAXP);
    const spGeo = new THREE.CylinderGeometry(0.02, 0.028, 0.07, 6);
    this.spiracles = new THREE.InstancedMesh(spGeo, new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.5 }), 2 * MAXP);
    this.hooks.frustumCulled = this.spiracles.frustumCulled = false;
    scene.add(this.hooks, this.spiracles);
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._sc = new THREE.Vector3(); this._e = new THREE.Euler();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);

    this.pts = Array.from({ length: NSEG + 2 }, () => new THREE.Vector3());
    this.ring = Array.from({ length: NR }, () => new THREE.Vector3());
    this.radii = new Float32Array(NR);
    this.contr = new Float32Array(NSEG);
    this._t = new THREE.Vector3(); this._n1 = new THREE.Vector3(); this._n2 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    // the gut's colour is a multiplier on the cuticle: pale on yeast and
    // agar, brown on fruit, darker as the animal fills
    this._gutPale = new THREE.Color(0xc8b48c);
    this._gutBrown = new THREE.Color(0x6a4522);

    // selection: a hairline ring on the agar around the animal
    this.marker = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.53, 96),
      new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    this.marker.renderOrder = 3;
    scene.add(this.marker);
    this.aoExcluded.push(this.marker);

    this.sezNodes = [];
    this.world.roles.forEach((r, i) => { if (r === 23) this.sezNodes.push(i); });
  }

  // Cuticle: cream with two dorsal tracheal trunks, faint segment folds and
  // ventral denticle belts. u runs around the body (dorsal at 0.25), v along it.
  skinTexture() {
    const W = 64, H = 512, NSEG = this.NSEG;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    c.fillStyle = "#f4efe3"; c.fillRect(0, 0, W, H);
    // faint cephalic darkening at the anterior
    const g = c.createLinearGradient(0, 0, 0, 40);
    g.addColorStop(0, "rgba(90,70,50,0.35)"); g.addColorStop(1, "rgba(90,70,50,0)");
    c.fillStyle = g; c.fillRect(0, 0, W, 40);
    // tracheal trunks
    c.strokeStyle = "rgba(70,60,50,0.55)"; c.lineWidth = 1.2;
    for (const x of [W * 0.25 - 3, W * 0.25 + 3]) {
      c.beginPath();
      for (let y = 20; y <= H; y += 8) { const wob = Math.sin(y * 0.05 + x) * 0.8; if (y === 20) c.moveTo(x + wob, y); else c.lineTo(x + wob, y); }
      c.stroke();
    }
    // segment folds and denticle belts
    for (let s = 1; s <= NSEG; s++) {
      const y = (s / NSEG) * H;
      c.fillStyle = "rgba(100,85,65,0.22)"; c.fillRect(0, y - 1.5, W, 3);
      if (s >= 3) {
        c.fillStyle = "rgba(40,30,20,0.7)";
        for (let k = 0; k < 9; k++) c.fillRect(W * 0.64 + k * 1.6, y - 8 + (k % 2), 1, 1.4);
      }
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  // ---------- the slime trail ----------
  // A top-down render target over the dish: every larva stamps its mid-body
  // each frame, and the whole sheet fades by dt. The agar shader reads it as
  // a gloss/darkening decal.
  buildTrail() {
    const { G, MAXP } = this;
    this.trailRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
    const tscene = this.trailScene = new THREE.Scene();
    const tcam = this.trailCam = new THREE.OrthographicCamera(G / 2, -G / 2, G / 2, -G / 2, 1, 100);
    tcam.position.set(0, 50, 0);
    tcam.up.set(0, 0, 1);
    tcam.lookAt(0, 0, 0);
    const fade = this.trailFade = new THREE.Mesh(new THREE.PlaneGeometry(G, G),
      new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.MultiplyBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    fade.rotation.x = -Math.PI / 2;
    fade.renderOrder = 0;
    const stampGeo = new THREE.CircleGeometry(0.32, 10);
    stampGeo.rotateX(-Math.PI / 2);
    const stamps = this.stamps = new THREE.InstancedMesh(stampGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.06, 0.06, 0.06), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide }), MAXP);
    stamps.renderOrder = 1;
    stamps.frustumCulled = false;
    tscene.add(fade, stamps);
    const r = this.renderer;
    r.setRenderTarget(this.trailRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.setRenderTarget(null);
  }
  renderTrail(dt) {
    const r = this.renderer;
    const tau = TRAIL_TICKS / this.world.tickrate;
    const f = Math.exp(-dt / tau);
    this.trailFade.material.color.setRGB(f, f, f);
    const auto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.trailRT);
    r.render(this.trailScene, this.trailCam);
    r.setRenderTarget(null);
    r.autoClear = auto;
  }

  // Rings along the path; normals are analytic (the radial direction tilted
  // back by the radius slope) so no per-frame normal recomputation.
  writeTube(geo, radialN, ring, radii, tail) {
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
    const t = this._t, n1 = this._n1, n2 = this._n2, NR = this.NR, W = radialN + 1;
    const cs = this._cs[radialN];
    for (let r = 0; r < NR; r++) {
      const p = ring[r];
      const ra = ring[Math.max(0, r - 1)], rb = ring[Math.min(NR - 1, r + 1)];
      t.subVectors(rb, ra);
      const seg = t.length() || 1;
      t.multiplyScalar(1 / seg);
      n1.crossVectors(t, this._up);
      if (n1.lengthSq() < 1e-6) n1.set(1, 0, 0); else n1.normalize();
      n2.crossVectors(n1, t).normalize();
      const rad = radii[r];
      // how fast the radius grows along the tube: the normal leans against it
      const slope = (radii[Math.min(NR - 1, r + 1)] - radii[Math.max(0, r - 1)]) / seg;
      const inv = 1 / Math.sqrt(1 + slope * slope);
      const tx = -t.x * slope * inv, ty = -t.y * slope * inv, tz = -t.z * slope * inv;
      for (let s = 0; s <= radialN; s++) {
        const ca = cs[s * 2], sa = cs[s * 2 + 1];
        const rx = n1.x * ca + n2.x * sa, ry = n1.y * ca + n2.y * sa, rz = n1.z * ca + n2.z * sa;
        const o = (r * W + s) * 3;
        pos[o] = p.x + rx * rad; pos[o + 1] = p.y + ry * rad; pos[o + 2] = p.z + rz * rad;
        nor[o] = rx * inv + tx; nor[o + 1] = ry * inv + ty; nor[o + 2] = rz * inv + tz;
      }
    }
    const headO = NR * W * 3;
    t.subVectors(ring[0], ring[1]).normalize();
    pos[headO] = ring[0].x + t.x * radii[0] * 0.9;
    pos[headO + 1] = ring[0].y + t.y * radii[0] * 0.9;
    pos[headO + 2] = ring[0].z + t.z * radii[0] * 0.9;
    nor[headO] = t.x; nor[headO + 1] = t.y; nor[headO + 2] = t.z;
    // (tail is the cap point beyond the last ring)
    pos[headO + 3] = tail.x; pos[headO + 4] = tail.y; pos[headO + 5] = tail.z;
    t.subVectors(tail, ring[NR - 1]).normalize();
    nor[headO + 3] = t.x; nor[headO + 4] = t.y; nor[headO + 5] = t.z;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
  }

  // Head at (x, y); the body trails along -heading, each segment turned by
  // its bend. The contraction wave shortens a segment where the bend signal
  // departs from the body's mean turn, so the peristalsis the engine writes
  // into bend_ptr travels head-to-tail as a visible squeeze.
  layout(i, xs, ys, heads, bends, scale) {
    const { G, NSEG, pts, contr, sub } = this;
    let wx = xs[i] / 65536 - G / 2, wz = ys[i] / 65536 - G / 2;
    const dir0 = (heads[i] / 65536) * TAU;
    let mean = 0;
    for (let s = 0; s < NSEG; s++) mean += bends[i * NSEG + s];
    mean /= NSEG;
    for (let s = 0; s < NSEG; s++) contr[s] = Math.min(1, Math.abs(bends[i * NSEG + s] - mean) / 6000);
    pts[0].set(wx, 0, wz);
    let dir = dir0;
    for (let s = 0; s < NSEG; s++) {
      dir = dir0 + (bends[i * NSEG + s] / 65536) * TAU;
      const len = SEGLEN * scale * (1 - 0.18 * contr[s]);
      wx -= Math.cos(dir) * len;
      wz -= Math.sin(dir) * len;
      pts[s + 1].set(wx, 0, wz);
    }
    wx -= Math.cos(dir) * SEGLEN * scale * 0.6;
    wz -= Math.sin(dir) * SEGLEN * scale * 0.6;
    pts[NSEG + 1].set(wx, 0, wz);
    // in a pool the animal floats with its back out of the liquid
    for (let k = 0; k < NSEG + 2; k++) pts[k].y = Math.max(sub.heightAt(pts[k].x, pts[k].z), WATER_Y - 0.1);
    return dir0;
  }

  updateLarvae() {
    const w = this.world, NR = this.NR, NSEG = this.NSEG;
    const alive = w.alive(), xs = w.xs(), ys = w.ys(), heads = w.headings(), bends = w.bends();
    const energy = w.energy(), fired = w.fired(), uids = w.uids(), ages = w.ages(), biome = w.biome();
    const G = this.G, ring = this.ring, radii = this.radii, pts = this.pts, prof = this.profile;
    const m4 = this._m4, q = this._q, sc = this._sc;
    const hooks = this.hooks, spir = this.spiracles, stamps = this.stamps;
    for (let i = 0; i < this.MAXP; i++) {
      const b = this.bodies[i];
      if (!alive[i]) {
        if (b.skin.visible) { b.skin.visible = false; b.uid = -1; }
        hooks.setMatrixAt(2 * i, this._zero); hooks.setMatrixAt(2 * i + 1, this._zero);
        spir.setMatrixAt(2 * i, this._zero); spir.setMatrixAt(2 * i + 1, this._zero);
        stamps.setMatrixAt(i, this._zero);
        if (this.selected === i) this.select(-1);
        if (this.tracking === i) this.tracking = -1;
        continue;
      }
      if (b.uid !== uids[i]) { b.uid = uids[i]; b.fill = 0; b.diet = 0; b.lastEnergy = energy[i]; }
      // a newborn grows into its full length over its first 400 ticks
      const scale = 0.62 + 0.38 * Math.min(1, ages[i] / 400);
      const dir0 = this.layout(i, xs, ys, heads, bends, scale);
      // what it eats colours the gut: energy rising over fruit browns it,
      // over yeast or agar it pales
      const e = energy[i];
      if (e > b.lastEnergy + 2) {
        const hx = Math.floor(xs[i] / 65536), hz = Math.floor(ys[i] / 65536);
        const here = (hx >= 0 && hz >= 0 && hx < G && hz < G) ? biome[hz * G + hx] : BIOME.AGAR;
        b.diet += ((here === BIOME.FRUIT ? 1 : 0) - b.diet) * 0.06;
      }
      b.lastEnergy = e;
      const fillT = Math.max(0, Math.min(1, e / 45000));
      b.fill += (fillT - b.fill) * 0.08;
      for (let r = 0; r < NR; r++) {
        const s = Math.floor(r / RPS), f = (r - s * RPS) / RPS;
        let bulge;
        if (f === 0) {
          ring[r].copy(pts[s]);
          bulge = r > 0 && r < NR - 1 ? 0.05 * (this.contr[s - 1] + this.contr[s]) : 0;
        } else {
          ring[r].lerpVectors(pts[s], pts[s + 1], f);
          bulge = 0.14 * this.contr[s] * Math.sin(Math.PI * f);
        }
        radii[r] = prof[r] * scale * (1 + bulge);
        ring[r].y += radii[r] * 0.9 + 0.01;
      }
      pts[NSEG + 1].y += 0.03;
      this.writeTube(b.skin.geometry, RADIAL, ring, radii, pts[NSEG + 1]);
      // the gut band: wider as the animal fills; the edge is the normal-view
      // cosine at which the band starts
      b.gutColor.copy(this._gutPale).lerp(this._gutBrown, b.diet).multiplyScalar(1 - 0.25 * b.fill);
      const gr = 0.36 + 0.2 * b.fill;
      b.gutEdge = Math.sqrt(1 - gr * gr);
      // mouth hooks: a dark pair at the anterior tip, spread when DN-SEZ fires
      let sez = 0;
      const base = i * this.world.MAXN;
      for (let k = 0; k < this.sezNodes.length; k++) if (fired[base + this.sezNodes[k]]) sez++;
      const spread = (sez ? 0.055 : 0.032) * scale;
      const hx = Math.cos(dir0), hz = Math.sin(dir0);
      const px = -hz, pz = hx;
      const head = ring[0];
      q.setFromEuler(this._e.set(0.35, -dir0 + Math.PI / 2, 0, "YXZ"));
      sc.set(scale, scale, scale);
      m4.compose(this._t.set(head.x + hx * 0.09 * scale + px * spread, head.y - radii[0] * 0.55, head.z + hz * 0.09 * scale + pz * spread), q, sc);
      hooks.setMatrixAt(2 * i, m4);
      m4.compose(this._t.set(head.x + hx * 0.09 * scale - px * spread, head.y - radii[0] * 0.55, head.z + hz * 0.09 * scale - pz * spread), q, sc);
      hooks.setMatrixAt(2 * i + 1, m4);
      // posterior spiracles: two short dark tubes on the last segment, tilted back
      const tp = ring[NR - 2], tq = ring[NR - 1];
      const tdx = tq.x - tp.x, tdz = tq.z - tp.z, tl = Math.hypot(tdx, tdz) || 1;
      const tdir = Math.atan2(tdz / tl, tdx / tl);
      q.setFromEuler(this._e.set(-0.5, -tdir + Math.PI / 2, 0, "YXZ"));
      const sw = 0.035 * scale;
      m4.compose(this._t.set(tq.x - (tdz / tl) * sw, tq.y + radii[NR - 1] * 0.8, tq.z + (tdx / tl) * sw), q, sc);
      spir.setMatrixAt(2 * i, m4);
      m4.compose(this._t.set(tq.x + (tdz / tl) * sw, tq.y + radii[NR - 1] * 0.8, tq.z - (tdx / tl) * sw), q, sc);
      spir.setMatrixAt(2 * i + 1, m4);
      // the trail is laid by the mid-body
      const mid = ring[NR >> 1];
      m4.makeScale(scale, 1, scale).setPosition(mid.x, 0, mid.z);
      stamps.setMatrixAt(i, m4);
      b.skin.visible = true;
      if (this.selected === i) {
        this.marker.position.set(mid.x, mid.y - radii[NR >> 1] * 0.9 + 0.03, mid.z);
        this.marker.visible = true;
      }
    }
    hooks.instanceMatrix.needsUpdate = spir.instanceMatrix.needsUpdate = stamps.instanceMatrix.needsUpdate = true;
  }

  select(slot) {
    this.selected = slot;
    this.marker.visible = slot >= 0;
    this.onSelect(slot);
  }

  // ---------- light ----------
  // Point the lamp's shadow frustum at (x, z) with the given half-size; the
  // texel size sets the normal bias so a flat agar never self-shadows.
  fitShadow(x, y, z, half) {
    const lamp = this.lamp;
    lamp.target.position.set(x, y, z);
    lamp.position.copy(this.lampDir).multiplyScalar(150).add(lamp.target.position);
    if (Math.abs(half - this.shadowHalf) < half * 0.15) return;
    this.shadowHalf = half;
    const c = lamp.shadow.camera;
    c.left = c.bottom = -half; c.right = c.top = half;
    c.updateProjectionMatrix();
    lamp.shadow.normalBias = (2 * half / 2048) * 1.5;
    lamp.shadow.bias = -(2 * half / 2048) * 0.02;
  }

  updateLight() {
    const l = this.world.sim.light_now() / 255;
    this.lamp.intensity = 0.3 + 2.0 * l;
    this.lamp.color.setRGB(0.72 + 0.28 * l, 0.78 + 0.17 * l, 0.92 - 0.04 * l);
    this.fill.intensity = 0.05 + 0.13 * l;
    this.scene.environmentIntensity = 0.1 + 0.3 * l;
    // the room goes to a dim blue-grey at night, never black
    this.scene.background.setRGB(0.62 * (0.26 + 0.74 * l), 0.60 * (0.28 + 0.72 * l), 0.56 * (0.36 + 0.64 * l));
    if (this.cone) this.cone.material.opacity = 0.03 + 0.08 * (1 - l);
  }

  // The substrate sweeps inside a time budget; a finished sweep queues one
  // upload per frame (albedo, normal, roughness, mesh) so no frame carries
  // all of them.
  updateSubstrate() {
    if (this.uploads.length) { this.uploads.shift()(); return; }
    if (this.sub.sweep(performance.now() + 2.5)) this.commitSubstrate();
  }
  commitSubstrate() {
    const push = (fn) => this.uploads.push(fn);
    push(() => { this.albedoTex.needsUpdate = true; });
    push(() => { this.normalTex.needsUpdate = true; });
    push(() => { this.ormTex.needsUpdate = true; });
    push(() => { this.agar.geometry.attributes.position.needsUpdate = true; });
    // fruit browns as it is eaten down
    for (const f of this.fruit) {
      let s = 0;
      for (const c of f.cells) s += this.sub.cellF[c];
      const fresh = s / f.cells.length;
      const k = 0.45 + 0.55 * fresh;
      f.mesh.material.color.setRGB(k, k * (0.85 + 0.15 * fresh), k * (0.8 + 0.2 * fresh));
      f.mesh.material.roughness = 0.32 + 0.4 * (1 - fresh);
    }
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
    // double-click follows a larva; double-click on bare agar lets go
    canvas.addEventListener("dblclick", (ev) => {
      if (this.fp.on) return;
      const rect = canvas.getBoundingClientRect();
      const hit = this.pick(ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height);
      this.tracking = hit;
      if (hit >= 0 && this.selected !== hit) this.select(hit);
    });
  }
  pick(px, py, w, h) {
    const wd = this.world;
    const alive = wd.alive(), xs = wd.xs(), ys = wd.ys();
    const v = this._t;
    let best = -1, bestD = 28;
    for (let i = 0; i < this.MAXP; i++) {
      if (!alive[i]) continue;
      const x = xs[i] / 65536 - this.G / 2, z = ys[i] / 65536 - this.G / 2;
      v.set(x, this.sub.heightAt(x, z) + 0.2, z).project(this.cam);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - px, (-v.y * 0.5 + 0.5) * h - py);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---------- camera: follow, drift ----------
  updateCamera(dt) {
    const c = this.controls;
    if (this.tracking >= 0) {
      const w = this.world;
      const xs = w.xs(), ys = w.ys(), i = this.tracking;
      const x = xs[i] / 65536 - this.G / 2, z = ys[i] / 65536 - this.G / 2;
      const y = this.sub.heightAt(x, z) + 0.15;
      const k = 1 - Math.exp(-dt * 5);
      const dx = (x - c.target.x) * k, dy = (y - c.target.y) * k, dz = (z - c.target.z) * k;
      c.target.x += dx; c.target.y += dy; c.target.z += dz;
      this.cam.position.x += dx; this.cam.position.y += dy; this.cam.position.z += dz;
    }
    c.autoRotate = performance.now() - this.lastInput > IDLE_MS;
    c.update();
    const d = this.cam.position.distanceTo(c.target);
    this.fitShadow(c.target.x, c.target.y, c.target.z, Math.min(64, Math.max(5, d * 0.5)));
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
    fp.x = tx + 2.2; fp.z = tz + 2.2;
    fp.yaw = Math.atan2(-(tx - fp.x), -(tz - fp.z));
    fp.pitch = -0.22;
    fp.vx = fp.vz = 0;
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
    const fp = this.fp;
    const k = fp.keys;
    const maxSpeed = k.ShiftLeft ? 7 : 3;
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
    this.cam.position.set(fp.x, this.sub.heightAt(fp.x, fp.z) + 0.75, fp.z);
    this.fitShadow(fp.x - Math.sin(fp.yaw) * 4, 0, fp.z - Math.cos(fp.yaw) * 4, 8);
    this.cam.quaternion.setFromEuler(this._e.set(fp.pitch, fp.yaw, 0, "YXZ"));
    this.cam.fov = 66; this.cam.updateProjectionMatrix();
    // focus on what is a few body lengths ahead
    this.bokeh.uniforms.focus.value = 3.2;
  }

  // ---------- frame ----------
  render(dt) {
    this.frame++;
    this.updateLight();
    this.updateSubstrate();
    this.updateLarvae();
    this.renderTrail(dt);
    if (this.fp.on) this.stepFP(dt); else this.updateCamera(dt);
    this.composer.render();
  }
}
