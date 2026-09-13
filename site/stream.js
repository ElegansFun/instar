// The world's /api/stream, read and smoothed. Frames arrive ten times a
// second; the renderer asks for the state at a moment a little in the past
// and gets every fly interpolated between the two frames around it, so
// sixty frames a second come out of ten. Nothing is extrapolated: a fly is
// never drawn where the world has not yet said it is.
import { API } from "./engine.js";

const TAU = Math.PI * 2;
// render this far behind the newest frame: one frame interval plus jitter
const LAG_MS = 160;
// no frame for this long and the stream is called stalled
const STALL_MS = 3000;
const RETRY_MS = [1000, 2000, 4000, 8000];

const lerp = (a, b, t) => a + (b - a) * t;
// shortest-arc interpolation on a circle of the given period
function lerpWrap(a, b, t, period) {
  let d = b - a;
  if (d > period / 2) d -= period; else if (d < -period / 2) d += period;
  return (a + d * t + period) % period;
}
// phases only advance: a wingbeat or leg cycle seen at 0.9 then 0.1 went
// forward through 1.0, not backward
function lerpAdvance(a, b, t, period) {
  let d = b - a;
  if (d < 0) d += period;
  return (a + d * t) % period;
}

export class Stream {
  constructor({ onFrame = () => {}, onEvent = () => {}, onState = () => {} } = {}) {
    this.onFrame = onFrame;
    this.onEvent = onEvent;
    this.onState = onState;
    this.prev = null;   // the two newest frames, with arrival times
    this.next = null;
    this.state = "connecting";
    this.es = null;
    this.retries = 0;
    this.frames = 0;
    this.t = 0;         // latest world tick seen
    this.light = 0;
    this.temp = 0;
    this.byId = new Map();   // id -> interpolated fly (reused objects)
    this.view = [];          // the flies as of the last sample(), in frame order
    this.stallTimer = 0;
    this.open();
  }

  open() {
    if (!API) { this.setState("lost"); return; }
    if (this.es) { this.es.close(); this.es = null; }
    const es = this.es = new EventSource(API + "/api/stream");
    es.onopen = () => { this.retries = 0; };
    es.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (!f || !Array.isArray(f.flies)) return;
      this.push(f, performance.now());
    };
    es.onerror = () => {
      // EventSource retries a dropped connection itself; a closed one (a
      // 4xx/5xx, or the world gone) is reopened here with backoff
      if (es.readyState === EventSource.CLOSED) {
        this.setState("lost");
        const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
        setTimeout(() => { if (this.es === es) this.open(); }, wait);
      } else this.setState(this.frames ? "reconnecting" : "connecting");
    };
  }
  close() { if (this.es) { this.es.close(); this.es = null; } }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  push(frame, at) {
    frame.at = at;
    // the first frame is doubled so there is always a pair to sample between
    this.prev = this.next || frame;
    this.next = frame;
    this.frames++;
    this.t = frame.t;
    this.light = frame.light;
    this.temp = frame.temp;
    this.setState("live");
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.setState("stalled"), STALL_MS);
    // the first frame carries the world's recent event history; only what
    // happened at or just before joining is news
    if (frame.events) for (const e of frame.events) if (this.frames > 1 || e.tick >= frame.t - 40) this.onEvent(e);
    this.onFrame(frame);
  }

  // The flies as of `now - LAG_MS`, interpolated. Flies present in only one
  // of the two frames (just born, just died) take that frame's state.
  sample(now) {
    const a = this.prev, b = this.next;
    this.view.length = 0;
    if (!b) return this.view;
    const span = b.at - a.at;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (now - LAG_MS - a.at) / span)) : 1;
    const prevById = a === b ? null : new Map(a.flies.map(f => [f.id, f]));
    const seen = new Set();
    for (const fb of b.flies) {
      const fa = prevById ? prevById.get(fb.id) : null;
      let v = this.byId.get(fb.id);
      if (!v) { v = { id: fb.id, legs: new Float32Array(6), fired: null, dh: 0 }; this.byId.set(fb.id, v); }
      seen.add(fb.id);
      v.slot = fb.slot;
      v.e = fb.e;
      v.fired = fb.fired;
      if (!fa) {
        v.mode = fb.mode; v.s = fb.s; v.x = fb.x; v.y = fb.y; v.z = fb.z; v.h = fb.h; v.p = fb.p; v.r = fb.r || 0; v.wb = fb.wb; v.pr = fb.pr;
        for (let k = 0; k < 6; k++) v.legs[k] = fb.legs[k];
      } else {
        v.mode = alpha < 0.5 ? fa.mode : fb.mode;
        v.s = alpha < 0.5 ? fa.s : fb.s;
        v.x = lerp(fa.x, fb.x, alpha); v.y = lerp(fa.y, fb.y, alpha); v.z = lerp(fa.z, fb.z, alpha);
        v.h = lerpWrap(fa.h, fb.h, alpha, TAU);
        v.p = lerp(fa.p, fb.p, alpha);
        v.r = lerpWrap(fa.r || 0, fb.r || 0, alpha, TAU);
        v.wb = fb.mode ? lerpAdvance(fa.wb, fb.wb, alpha, 1) : fb.wb;
        v.pr = lerp(fa.pr, fb.pr, alpha);
        for (let k = 0; k < 6; k++) v.legs[k] = lerpAdvance(fa.legs[k], fb.legs[k], alpha, 256);
      }
      // heading rate over the frame pair, for banking in flight (radians per second)
      if (fa && span > 0) {
        let d = fb.h - fa.h;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        v.dh = d / (span / 1000);
      } else v.dh = 0;
      this.view.push(v);
    }
    for (const id of this.byId.keys()) if (!seen.has(id)) this.byId.delete(id);
    return this.view;
  }

  // the newest frame's record for one fly, or null
  latest(id) {
    if (!this.next) return null;
    for (const f of this.next.flies) if (f.id === id) return f;
    return null;
  }
}
