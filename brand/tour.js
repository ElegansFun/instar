// The pinned video's camera tour, run inside cage.html on the live world.
// Rendering is offline: the page's clock is replaced by one that advances a
// thirtieth of a second per step, the stream's frames are queued and let in
// one per hundred virtual milliseconds, and each step draws exactly one
// frame at the tour's camera. Every frame is then screenshotted (see
// brand/README.md), so the result is smooth however long a frame takes to
// draw and encode. Nothing in the world is touched; the flies shown are the
// live flies, at the world's own speed.
//
// Evaluate this file in the page, then `__tour.init(plan)` once,
// `__tour.seg(i)` at the start of each segment, `await __tour.step()` per
// frame. `plan` is brand/social/tour.json.
(() => {
  const { cage, stream } = window.__instar;
  const V = cage.cam.position.constructor;
  const RAD = Math.PI / 180;
  const realRaf = window.requestAnimationFrame.bind(window);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  const tour = window.__tour = {};

  let fps = 30, dtMs = 1000 / 30;
  let vnow = 0, lastAt = 0, loop = null, segI = -1, segT = 0, fly = -1;
  const lastFly = new V();
  const queue = [];
  let prev = null;   // the pose at the end of the previous segment, blended from

  const dock = (id, open) => {
    const b = document.querySelector(`#dock button[data-win="${id}"]`);
    if (b && b.classList.contains("on") !== open) b.click();
  };
  const flyPos = () => {
    const f = fly >= 0 ? cage.flyById(fly) : null;
    if (f) cage.toScene(f.x, f.y, f.z, lastFly);
    return lastFly;
  };
  // a walking fly on the floor nearest the cage centre, else any fly
  const pickFly = () => {
    const fs = cage.flies.slice();
    if (!fs.length) return -1;
    const score = (f) => (f.mode === 1 ? 1e6 : 0) + (f.z > 0.5 ? 1e5 : 0) + Math.hypot(f.x - cage.G / 2, f.y - cage.G / 2);
    fs.sort((a, b) => score(a) - score(b));
    return fs[0].id;
  };
  // camera on a sphere about `target`; `shift` slides the frame so the
  // subject sits right of centre, clear of the windows on the left
  const orbit = (target, dist, az, el, shift = 0) => {
    const pos = new V(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), Math.cos(az * RAD) * Math.cos(el * RAD)).multiplyScalar(dist).add(target);
    const t = target.clone();
    if (shift) {
      const fwd = t.clone().sub(pos).normalize();
      const right = new V().crossVectors(fwd, new V(0, 1, 0)).normalize();
      const s = right.multiplyScalar(-shift * dist * Math.tan(cage.cam.fov * RAD / 2) * cage.cam.aspect);
      pos.add(s); t.add(s);
    }
    return { pos, target: t };
  };
  const centre = new V(0, cage.H * 0.36, 0);
  const wide = (t, len, az0) => orbit(centre, 290 - 25 * (t / len), az0 + 20 * (t / len), 24);
  const inspector = (open) => document.getElementById("win-inspect").classList.toggle("open", open);

  // the shots: each returns the pose wanted at segment-time t (s)
  const SHOTS = [
    { glide: 0, start() {}, pose: (t, len) => wide(t, len, 35) },
    { glide: 4.5, start() { fly = pickFly(); if (fly >= 0) cage.select(fly); }, pose: (t) => orbit(flyPos().clone().add(new V(0, 0.5, 0)), 9, 80 + 4 * t, 22, 0.3) },
    { glide: 3, start() { inspector(false); dock("win-brain", true); }, pose: (t) => orbit(flyPos().clone().add(new V(0, 0.6, 0)), 7.5, 152 + 3 * t, 17, 0.32) },
    { glide: 4, start() { dock("win-brain", false); inspector(true); }, pose: (t) => orbit(flyPos().clone().add(new V(0, 1.5, 0)), 34, 188 + 2 * t, 30, 0.2) },
    { glide: 5, start() { cage.select(-1); fly = -1; dock("win-market", false); dock("win-activity", true); }, pose: (t, len) => wide(t, len, 215) },
  ];

  tour.init = (plan) => {
    fps = plan.fps; dtMs = 1000 / fps;
    tour.plan = plan;
    vnow = performance.now();
    performance.now = () => vnow;
    window.requestAnimationFrame = (cb) => { loop = cb; return 0; };
    const push = stream.push.bind(stream);
    stream.push = (f) => { queue.push(f); };
    tour._release = (f, at) => push(f, at);
    lastAt = stream.next ? stream.next.at : vnow;
    stream.setState = () => {};
    stream.state = "live";
    const c = cage.controls;
    c.enableDamping = false; c.autoRotate = false; c.enableRotate = false; c.enableZoom = false; c.enablePan = false;
    for (const id of ["win-market", "win-flies", "win-mine", "win-activity", "win-brain", "win-account"]) dock(id, id === "win-market");
    cage.select(-1);
    cage.lastInput = Infinity;
    cage.tracking = -1;
    document.getElementById("hint").style.display = "none";
    return new Promise(r => realRaf(() => r(true)));   // the page's loop parks itself on the next rAF
  };

  tour.seg = (i) => {
    prev = { pos: cage.cam.position.clone(), target: cage.controls.target.clone() };
    segI = i; segT = 0;
    SHOTS[i].start();
  };

  tour.step = async () => {
    vnow += dtMs;
    // let the world in at its own pace: one frame per 100 virtual ms
    while (vnow - lastAt >= 100) {
      while (!queue.length) await sleep(20);
      lastAt += 100;
      tour._release(queue.shift(), lastAt);
    }
    const shot = SHOTS[segI], len = tour.plan.segments[segI].len;
    const want = shot.pose(segT, len);
    const k = shot.glide ? smooth(segT / shot.glide) : 1;
    cage.cam.position.copy(prev.pos).lerp(want.pos, k);
    cage.controls.target.copy(prev.target).lerp(want.target, k);
    segT += dtMs / 1000;
    if (!loop) throw new Error("the page's loop has not parked");
    const cb = loop; loop = null;
    cb();
    if (!loop) throw new Error("the page's loop did not re-arm");
    await new Promise(r => realRaf(r));   // the drawn frame reaches the compositor
    return { tick: stream.t, queued: queue.length, fly, flies: cage.flies.length, light: stream.light };
  };
})();
