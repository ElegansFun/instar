// Derives every brand asset from fly.svg (the plate) and the site's palette:
//   mark.svg      roundel with the fly, bold strokes (site header, favicon)
//   wordmark.svg  "Instar" in Instrument Serif, font embedded, self-contained
//   compose.html  the raster set laid out at exact pixel sizes; rasterise it
//                 with `node brand/build.mjs` then a browser screenshot of each
//                 [data-asset] element (scripts in README.md)
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const site = path.join(dir, "..", "site");
const PAPER = "#F3EEE3", INK = "#141311", AMBER = "#C98A2B";

const fly = fs.readFileSync(path.join(dir, "fly.svg"), "utf8");
const inner = fly.slice(fly.indexOf("<defs>"), fly.lastIndexOf("</svg>"));

/// The plate's strokes are drawn for a 600 px figure; a 64 px roundel needs
/// them thicker in figure units or they vanish. Fills stay.
const boldened = (svgInner, factor) => svgInner.replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${(Number(w) * factor).toFixed(2)}"`);

// ---- mark: two rings, the fly scaled into them ----
const figureBox = { x: 40, y: 24, w: 220, h: 205 }; // measured extent of fly.svg's figure
function mark(size, ringed = true) {
  const r = size / 2;
  const k = size / 64;
  const fit = (size * 0.64) / Math.max(figureBox.w, figureBox.h);
  const tx = r - (figureBox.x + figureBox.w / 2) * fit, ty = r - (figureBox.y + figureBox.h / 2) * fit;
  const rings = ringed
    ? `<circle cx="${r}" cy="${r}" r="${(r - 2.5 * k).toFixed(1)}" fill="none" stroke="${INK}" stroke-width="${(1.5 * k).toFixed(2)}"/>\n  <circle cx="${r}" cy="${r}" r="${(r - 6 * k).toFixed(1)}" fill="none" stroke="${INK}" stroke-width="${(0.5 * k).toFixed(2)}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <title>Instar</title>
  <g id="m">
  ${rings}
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${fit.toFixed(4)})">
  ${boldened(inner, 2.6)}
  </g>
  </g>
</svg>
`;
}
fs.writeFileSync(path.join(dir, "mark.svg"), mark(64));
fs.writeFileSync(path.join(dir, "mark-plain.svg"), mark(64, false));
fs.writeFileSync(path.join(site, "mark.svg"), mark(64));
fs.writeFileSync(path.join(site, "favicon.svg"), mark(64));

// ---- wordmark with the face embedded (Instrument Serif, OFL) ----
const font = fs.readFileSync(path.join(site, "fonts", "instrument-serif-latin-400-normal.woff2")).toString("base64");
const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 96" width="300" height="96">
  <title>Instar</title>
  <style>@font-face{font-family:"Instrument Serif";src:url(data:font/woff2;base64,${font}) format("woff2")}</style>
  <text x="0" y="76" font-family="Instrument Serif, Georgia, serif" font-size="92" letter-spacing="-1" fill="${INK}">Instar</text>
</svg>
`;
fs.writeFileSync(path.join(dir, "wordmark.svg"), wordmark);

// ---- the raster set ----
// Every inline copy gets its own ids: a document with two `#wing`s draws
// both flies from the first one, wherever it is.
let n = 0;
const instance = (svg) => { const s = `-${++n}`; return svg.replace(/id="(\w+)"/g, `id="$1${s}"`).replace(/href="#(\w+)"/g, `href="#$1${s}"`); };
const markSvg = () => instance(mark(64));
/// the plate cropped to its figure (the source leaves room below) and, for
/// large rasters, with heavier strokes
const plate = (bold = 1, box = '16 16 268 222') => instance(boldened(fly.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"').replace(/viewBox="[^"]+"/, 'viewBox="' + box + '"'), bold));
const css = `
@font-face{font-family:"Instrument Serif";src:url(../site/fonts/instrument-serif-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:italic;src:url(../site/fonts/instrument-serif-latin-400-italic.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";src:url(../site/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:500;src:url(../site/fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2")}
body{margin:0;background:#888;font-family:"Instrument Serif",Georgia,serif;color:${INK}}
[data-asset]{position:relative;overflow:hidden;background:${PAPER};margin:24px;box-sizing:border-box}
.serif{font-family:"Instrument Serif",Georgia,serif;font-weight:400;letter-spacing:-0.01em;line-height:0.98}
.mono{font-family:"IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:0.14em;color:#4A4640}
.rule{position:absolute;left:0;right:0;height:1px;background:rgba(20,19,17,.55)}
.cap{position:absolute;font-family:"IBM Plex Mono",monospace;color:#4A4640}
`;
const html = `<!doctype html><meta charset="utf-8"><title>Instar brand</title><style>${css}</style>

<!-- profile picture: the plate fly on paper; everything important inside the circle X crops to -->
<div data-asset="pfp-1024" style="width:1024px;height:1024px">
  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
    <div style="width:720px;height:720px">${plate(1.6)}</div>
  </div>
</div>

<!-- X header 1500x500: safe area is the middle; the profile picture covers the bottom-left corner -->
<div data-asset="banner-x-1500x500" style="width:1500px;height:500px">
  <div class="mono" style="position:absolute;left:100px;top:64px;font-size:18px">Drosophila melanogaster &nbsp;·&nbsp; Janelia MaleCNS v1.0 &nbsp;·&nbsp; Solana</div>
  <div style="position:absolute;left:96px;top:118px;width:900px">
    <div class="serif" style="font-size:96px">A cage of flies,<br>each driven by a complete<br><i>wiring diagram.</i></div>
  </div>
  <div style="position:absolute;right:56px;top:-6px;width:520px;height:520px;transform:rotate(-8deg)">${plate()}</div>
</div>

<!-- link preview / Open Graph 1200x630 -->
<div data-asset="og-1200x630" style="width:1200px;height:630px">
  <div style="position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:18px">
    <div style="width:56px;height:56px">${markSvg()}</div>
    <div class="serif" style="font-size:44px">Instar</div>
  </div>
  <div class="rule" style="top:140px;left:72px;right:72px"></div>
  <div style="position:absolute;left:72px;top:190px;width:760px">
    <div class="serif" style="font-size:78px">A cage of flies,<br>each driven by a complete<br><i>wiring diagram.</i></div>
  </div>
  <div class="mono" style="position:absolute;left:72px;bottom:56px;font-size:16px">Drosophila melanogaster &nbsp;·&nbsp; Janelia MaleCNS v1.0 &nbsp;·&nbsp; every fly a Core NFT on Solana</div>
  <div style="position:absolute;right:40px;top:120px;width:470px;height:470px;transform:rotate(-8deg)">${plate()}</div>
</div>

<!-- square social card 1080x1080 (Telegram, pump.fun, posts) -->
<div data-asset="card-1080" style="width:1080px;height:1080px">
  <div style="position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:18px">
    <div style="width:56px;height:56px">${markSvg()}</div>
    <div class="serif" style="font-size:44px">Instar</div>
  </div>
  <div class="rule" style="top:140px;left:72px;right:72px"></div>
  <div style="position:absolute;left:0;right:0;top:160px;display:flex;justify-content:center">
    <div style="width:560px;height:560px">${plate()}</div>
  </div>
  <div style="position:absolute;left:72px;right:72px;top:740px">
    <div class="serif" style="font-size:60px">A cage of flies, each driven by<br>a complete <i>wiring diagram.</i></div>
  </div>
  <div class="mono" style="position:absolute;left:72px;bottom:56px;font-size:16px">Drosophila melanogaster &nbsp;·&nbsp; Janelia MaleCNS v1.0 &nbsp;·&nbsp; Solana</div>
</div>

<!-- icons -->
<div data-asset="icon-512" style="width:512px;height:512px"><div style="position:absolute;inset:0">${instance(mark(512))}</div></div>
<div data-asset="apple-touch-icon-180" style="width:180px;height:180px"><div style="position:absolute;inset:14px">${instance(mark(152, false))}</div></div>
<div data-asset="favicon-32" style="width:32px;height:32px"><div style="position:absolute;inset:0">${instance(mark(32))}</div></div>
`;
fs.writeFileSync(path.join(dir, "compose.html"), html);
console.log("wrote mark.svg, mark-plain.svg, wordmark.svg, compose.html");
