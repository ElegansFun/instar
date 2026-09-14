// The pinned video for X, assembled from parts that are each made by one
// tool and kept on disk so any one of them can be redone alone:
//
//   node brand/video.mjs narrate    narration.json -> nar-N.wav (edge-tts, a
//                                   neural voice; python -m pip install edge-tts)
//   node brand/video.mjs plan       -> tour.json: the six segments with their
//                                   lengths (narration + a beat), read by
//                                   brand/tour.js when the cage is captured
//   node brand/video.mjs assemble   frames/seg-N/*.png + cap-N.png + nar-N.wav
//                                   + hero.png -> pinned.mp4 (1920x1080, 30 fps)
//
// The frames come from brand/tour.js run inside cage.html (see brand/README.md).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, "social");
const frames = path.join(out, "frames");
const FPS = 30, W = 1920, CAGE_H = 900, CAP_H = 180;
const VOICE = process.env.INSTAR_VOICE || "en-GB-RyanNeural";
// the last segment is the hero card: no cage frames, no caption strip
const HERO = 5;

const lines = JSON.parse(fs.readFileSync(path.join(out, "narration.json"), "utf8"));
const wav = (i) => path.join(out, `nar-${i}.wav`);
const seconds = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) { console.error(`${cmd} failed (${r.status})`); process.exit(1); }
};

function narrate() {
  lines.forEach((text, i) => {
    const mp3 = path.join(out, `nar-${i}.mp3`);
    run("python", ["-m", "edge_tts", "--voice", VOICE, "--rate=-6%", "--text", text, "--write-media", mp3]);
    run("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ar", "48000", "-ac", "2", wav(i)]);
    fs.unlinkSync(mp3);
    console.log(`nar-${i}.wav ${seconds(wav(i)).toFixed(1)} s: ${text.slice(0, 60)}…`);
  });
}

// a segment holds for its narration plus a beat before and after, never
// shorter than the shot needs to read
function plan() {
  const MIN = [10, 10, 8, 8, 8, 6];
  const segs = lines.map((_, i) => {
    const nar = seconds(wav(i));
    const len = Math.max(MIN[i], Math.ceil((nar + 2.0) * 2) / 2);
    return { nar: Number(nar.toFixed(2)), len, frames: Math.round(len * FPS) };
  });
  fs.writeFileSync(path.join(out, "tour.json"), JSON.stringify({ fps: FPS, segments: segs }, null, 2) + "\n");
  console.log(segs.map((s, i) => `seg ${i}: ${s.len} s (${s.frames} frames, narration ${s.nar} s)`).join("\n"));
  console.log(`total ${segs.reduce((a, s) => a + s.len, 0)} s`);
}

function assemble() {
  const { segments } = JSON.parse(fs.readFileSync(path.join(out, "tour.json"), "utf8"));
  const inputs = [], filter = [], vparts = [], aparts = [];
  let n = 0, at = 0;
  segments.forEach((s, i) => {
    if (i === HERO) {
      inputs.push("-loop", "1", "-framerate", String(FPS), "-t", String(s.len), "-i", path.join(out, "hero.png"));
      filter.push(`[${n}:v]scale=${W}:${CAGE_H + CAP_H}:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${s.len - 0.8}:d=0.8,setsar=1[v${i}]`);
      n++;
    } else {
      const d = path.join(frames, `seg-${i}`);
      const count = fs.readdirSync(d).filter(f => f.endsWith(".png")).length;
      if (count !== s.frames) { console.error(`seg-${i}: ${count} frames on disk, tour.json wants ${s.frames}`); process.exit(1); }
      inputs.push("-framerate", String(FPS), "-i", path.join(d, "%05d.png"));
      inputs.push("-loop", "1", "-framerate", String(FPS), "-t", String(s.len), "-i", path.join(out, `cap-${i}.png`));
      const fadeIn = i === 0 ? ",fade=t=in:st=0:d=0.6" : "";
      filter.push(`[${n}:v]scale=${W}:${CAGE_H}:flags=lanczos${fadeIn}[c${i}];[${n + 1}:v]scale=${W}:${CAP_H}:flags=lanczos,fade=t=in:st=0:d=0.4:alpha=0[k${i}];[c${i}][k${i}]vstack,format=yuv420p,setsar=1[v${i}]`);
      n += 2;
    }
    vparts.push(`[v${i}]`);
    // narration starts one beat into the segment
    inputs.push("-i", wav(i));
    filter.push(`[${n}:a]adelay=${Math.round((at + 1.0) * 1000)}|${Math.round((at + 1.0) * 1000)}[a${i}]`);
    aparts.push(`[a${i}]`);
    n++;
    at += s.len;
  });
  filter.push(`${vparts.join("")}concat=n=${segments.length}:v=1:a=0[v]`);
  // the voice sits at about -25 dB mean out of edge-tts; bring it to the
  // -16 LUFS that phones and X expect
  filter.push(`${aparts.join("")}amix=inputs=${segments.length}:normalize=0,apad,atrim=0:${at},loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
  run("ffmpeg", ["-v", "error", "-stats", "-y", ...inputs, "-filter_complex", filter.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", path.join(out, "pinned.mp4")]);
  console.log(`pinned.mp4: ${at} s`);
}

const cmd = process.argv[2];
if (cmd === "narrate") narrate();
else if (cmd === "plan") plan();
else if (cmd === "assemble") assemble();
else { console.error("usage: node brand/video.mjs narrate | plan | assemble"); process.exit(2); }
