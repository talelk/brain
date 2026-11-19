// Primitives "grande police" pour les diagrammes denses (lisibles dans Word à 17 cm de large)
const L = require("./lib");
const { logo, esc, edge } = L;

// feuille de style complémentaire, placée dans le corps du SVG (surcharge lib.js sans le modifier)
const STYLE = `<style>
.tname{font-size:16.5px} .sub{font-size:15.5px} .sub.sm{font-size:15px}
.stage{font-size:12.5px} .zlabel{font-size:13px} .legend{font-size:15px}
.mono{font-size:15px} .elabel{font-size:14px} .ptxt{font-size:15.5px}
.title{font-size:22px} .title.sm{font-size:18px} .numt{font-size:14px}
</style>`;

function bcard({ x, y, w, h, logo: lg, stage, name, sub = [], cls = "", logoSize = 36 }) {
  let s = `<rect class="card ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`;
  let tx = x + 16;
  if (lg) {
    s += `<rect class="logobg" x="${x + 12}" y="${y + 12}" width="${logoSize + 12}" height="${logoSize + 12}" rx="9"/>` + logo(lg, x + 18, y + 18, logoSize);
    tx = x + 12 + logoSize + 12 + 12;
  }
  let ty = y + 28;
  if (stage) { s += `<text class="stage" x="${tx}" y="${ty}">${esc(stage)}</text>`; ty += 23; }
  else ty += 4;
  s += `<text class="tname" x="${tx}" y="${ty}">${esc(name)}</text>`;
  sub.forEach((l, i) => { s += `<text class="sub" x="${tx}" y="${ty + 22 + i * 20}">${esc(l)}</text>`; });
  return s;
}
function bchip({ x, y, w, h = 58, logo: lg, name, sub, cls = "", logoSize = 28 }) {
  let s = `<rect class="card ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>`;
  let tx = x + 14;
  if (lg) { s += `<rect class="logobg" x="${x + 9}" y="${y + (h - logoSize) / 2 - 3}" width="${logoSize + 6}" height="${logoSize + 6}" rx="7"/>` + logo(lg, x + 12, y + (h - logoSize) / 2, logoSize); tx = x + 12 + logoSize + 14; }
  if (sub) s += `<text class="tname" x="${tx}" y="${y + 24}">${esc(name)}</text><text class="sub sm" x="${tx}" y="${y + 45}">${esc(sub)}</text>`;
  else s += `<text class="tname" x="${tx}" y="${y + h / 2 + 6}">${esc(name)}</text>`;
  return s;
}
function blegend(x, y, items) {
  let s = "", cx = x;
  for (const it of items) {
    s += edge([[cx, y], [cx + 34, y]], it.type);
    s += `<text class="legend" x="${cx + 44}" y="${y + 5}">${esc(it.label)}</text>`;
    cx += 44 + it.label.length * 8.3 + 30;
  }
  return s;
}
module.exports = { STYLE, bcard, bchip, blegend };
