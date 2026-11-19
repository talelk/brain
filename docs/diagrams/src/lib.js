// Bibliothèque de dessin SVG — style OpenLakeForge (tokens repris du SVG officiel OLF)
const fs = require("fs");
const path = require("path");
const si = require("simple-icons");
const LOGO_DIR = path.join(__dirname, "..", "assets", "logos");

const THEMES = {
  light: { bg:"#ffffff", border:"#c9d1dc", zone:"#e9edf2", zlabel:"#5b6878", card:"#ffffff", cardStroke:"#c9d1dc",
    text:"#17202b", sub:"#5b6878", data:"#17202b", ctl:"#5b6878", lin:"#7a52d1", chipStroke:"#dbe1e9", logoBg:"#ffffff",
    blue:"#2f6fd6", green:"#3f8a3a", orange:"#c8641a", violet:"#7a52d1", gold:"#b98b0e", red:"#b4235a",
    bronzeF:"#f6e7da", bronzeS:"#b06a35", silverF:"#e8edf3", silverS:"#6f7f92", goldF:"#fbf1d0", goldS:"#b98b0e",
    tintBlue:"#e3ecfa", tintGreen:"#e4f1e1", tintOrange:"#fde9db", tintViolet:"#ece6fa", tintRed:"#fbe3ec", tintGold:"#fbf1d0" },
  dark: { bg:"#0e1622", border:"#2c3d52", zone:"#16212f", zlabel:"#8fa2b8", card:"#1b2a3b", cardStroke:"#35495f",
    text:"#e7eef6", sub:"#9fb1c5", data:"#d5e0ec", ctl:"#8fa2b8", lin:"#a98bf0", chipStroke:"#35495f", logoBg:"#f4f7fa",
    blue:"#5b94ef", green:"#6bbf63", orange:"#f09040", violet:"#a98bf0", gold:"#e0b630", red:"#f0628f",
    bronzeF:"#3a2a1f", bronzeS:"#d58a52", silverF:"#26323f", silverS:"#8fa2b8", goldF:"#3a3216", goldS:"#e0b630",
    tintBlue:"#1d3556", tintGreen:"#1f3a21", tintOrange:"#45301b", tintViolet:"#2d2552", tintRed:"#4a1f30", tintGold:"#3a3216" },
};
const SANS = "'Noto Sans','Inter','Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','DejaVu Sans Mono',ui-monospace,Menlo,monospace";

const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
let UID = 0;

function styleSheet(t) {
  return `
text{font-family:${SANS};font-variant-ligatures:none}
.zone{fill:${t.zone}} .zlabel{font:500 11px ${MONO};letter-spacing:.1em;fill:${t.zlabel}}
.card{fill:${t.card};stroke:${t.cardStroke};stroke-width:1.2} .card.opt{stroke-dasharray:6 5;stroke-width:1.5}
.card.blue{stroke:${t.blue};stroke-width:1.8} .card.green{stroke:${t.green};stroke-width:1.8} .card.orange{stroke:${t.orange};stroke-width:1.8}
.card.violet{stroke:${t.violet};stroke-width:1.8} .card.red{stroke:${t.red};stroke-width:1.8} .card.gold{stroke:${t.gold};stroke-width:1.8}
.logobg{fill:${t.logoBg};stroke:${t.chipStroke}}
.stage{font:500 10px ${MONO};letter-spacing:.08em;fill:${t.sub}}
.title{font-size:17px;font-weight:650;fill:${t.text}} .title.big{font-size:22px} .title.sm{font-size:14.5px}
.tname{font-size:13.5px;font-weight:600;fill:${t.text}}
.sub{font-size:12.5px;fill:${t.sub}} .sub.sm{font-size:11.5px}
.mono{font:500 11.5px ${MONO};fill:${t.text}}
.elabel{font:500 10.5px ${MONO};fill:${t.sub};paint-order:stroke;stroke:${t.zone};stroke-width:5px;stroke-linejoin:round}
.elabel.onbg{stroke:${t.bg}}
.edge path{fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.edge.data path{stroke:${t.data}} .edge.ctl path{stroke:${t.ctl};stroke-dasharray:2 5;stroke-width:1.6}
.edge.lin path{stroke:${t.lin};stroke-dasharray:7 5} .edge.deny path{stroke:${t.red};stroke-dasharray:5 4}
.ah-data{fill:${t.data}} .ah-ctl{fill:${t.ctl}} .ah-lin{fill:${t.lin}} .ah-deny{fill:${t.red}}
.cyl,.cyltop{stroke-width:1.4}
.bronze .cyl,.bronze .cyltop{fill:${t.bronzeF};stroke:${t.bronzeS}} .silver .cyl,.silver .cyltop{fill:${t.silverF};stroke:${t.silverS}}
.gold .cyl,.gold .cyltop{fill:${t.goldF};stroke:${t.goldS}}
.pill{fill:${t.card};stroke:${t.cardStroke};stroke-width:1.2} .pill.strong{stroke:${t.data}}
.ptxt{font-size:12.5px;font-weight:500;fill:${t.text}}
.legend{font-size:12px;fill:${t.text}}
.num{fill:${t.card};stroke:${t.cardStroke};stroke-width:1.2} .numt{font:600 12px ${MONO};fill:${t.text}}
.band{stroke-width:1.2}
`;
}

// ---------- logos ----------
const SI_ALIAS = { argocd:"argo", rke2:"rancher", superset:"apachesuperset", kafka:"apachekafka", nifi:"apachenifi" };
function logoSpec(name) {
  const base = name.toLowerCase();
  for (const ext of ["svg","png"]) {
    const f = path.join(LOGO_DIR, `${base}.${ext}`);
    if (fs.existsSync(f)) return { kind:"img", mime: ext==="png"?"image/png":"image/svg+xml", b64: fs.readFileSync(f).toString("base64") };
  }
  const key = Object.keys(si).find(k => k.toLowerCase() === "si" + (SI_ALIAS[base] || base));
  if (key) return { kind:"path", d: si[key].path, hex: "#" + si[key].hex };
  return null;
}
// pastille monogramme pour les composants sans logo officiel disponible
const MONO_COLORS = { auth:"#2f6fd6", trigger:"#2f6fd6", plays:"#3f8a3a", gateway:"#7a52d1", approvals:"#c8641a", tools:"#5b6878", queue:"#3f8a3a", fts:"#5b6878", integrations:"#2f6fd6", health:"#b4235a", runner:"#3f8a3a", engines:"#7a52d1", egress:"#c8641a", teams:"#5059c9", backup:"#5b6878", cron:"#2f6fd6", debezium:"#d46a1c", opa:"#2a6f97", wazuh:"#1b79c9", loki:"#e8a400", evidently:"#e0457b", oracle:"#c74634", floe:"#2f6fd6", ceph:"#ef5c55" };
const MONO_TEXT = { auth:"Au", trigger:"Tg", plays:"Pl", gateway:"Gw", approvals:"Ap", tools:"fx", queue:"Fa", fts:"Me", integrations:"In", health:"Sa", runner:"Ru", engines:"Mo", egress:"Px", teams:"Tm", backup:"Bk", cron:"Cr" };
function logo(name, x, y, size) {
  const spec = logoSpec(name);
  if (!spec) {
    const c = MONO_COLORS[name.toLowerCase()] || "#5b6878";
    const t = MONO_TEXT[name.toLowerCase()] || name.slice(0,2).replace(/^./, m=>m.toUpperCase());
    return `<g transform="translate(${x},${y})"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="${c}"/><text x="${size/2}" y="${size/2+size*0.17}" text-anchor="middle" font-size="${size*0.46}" font-weight="700" fill="#fff" font-family="${SANS}">${esc(t)}</text></g>`;
  }
  if (spec.kind === "img") return `<image x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" href="data:${spec.mime};base64,${spec.b64}"/>`;
  const s = size / 24;
  return `<g transform="translate(${x},${y}) scale(${s})"><path d="${spec.d}" fill="${spec.hex}"/></g>`;
}

// ---------- document ----------
function doc({ w, h, theme = "light", title, desc, body }) {
  const t = THEMES[theme];
  const id = ++UID;
  const mk = (cls, color) => `<marker id="ah${cls}${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="ah-${cls}" fill="${color}"/></marker><marker id="as${cls}${id}" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M10,0 L0,5 L10,10 z" class="ah-${cls}" fill="${color}"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"><title>${esc(title)}</title><desc>${esc(desc||title)}</desc>
<defs><style>${styleSheet(t)}</style>${mk("data",t.data)}${mk("ctl",t.ctl)}${mk("lin",t.lin)}${mk("deny",t.red)}</defs>
<rect x="0.5" y="0.5" width="${w-1}" height="${h-1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
${body.replace(/#AH-(\w+)#/g, (_, c) => `#ah${c}${id}`).replace(/#AS-(\w+)#/g, (_, c) => `#as${c}${id}`)}</svg>`;
}

// ---------- primitives ----------
const lane = (x,y,w,h,label,opts={}) => `<rect class="zone" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"${opts.fill?` style="fill:${opts.fill}"`:""}/>` +
  (label ? `<text class="zlabel" x="${x+16}" y="${y+22}">${esc(label)}</text>` : "");

function card({ x,y,w,h, logo:lg, stage, name, sub, subLines, cls="", nameCls="tname", logoSize=36 }) {
  let s = `<rect class="card ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`;
  let tx = x + 14;
  if (lg) {
    s += `<rect class="logobg" x="${x+12}" y="${y+12}" width="${logoSize+12}" height="${logoSize+12}" rx="9"/>` + logo(lg, x+18, y+18, logoSize);
    tx = x + 12 + logoSize + 12 + 12;
  }
  let ty = y + 26;
  if (stage) { s += `<text class="stage" x="${tx}" y="${ty}">${esc(stage)}</text>`; ty += 19; }
  s += `<text class="${nameCls}" x="${tx}" y="${ty}">${esc(name)}</text>`;
  const lines = subLines || (sub ? String(sub).split("\n") : []);
  lines.forEach((l,i) => { s += `<text class="sub" x="${tx}" y="${ty+19+i*16}">${esc(l)}</text>`; });
  return s;
}
// carte compacte (pastille logo + nom + sous-texte court) sans cadre de logo
function chip({ x,y,w,h, logo:lg, name, sub, cls="", logoSize=26 }) {
  let s = `<rect class="card ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>`;
  let tx = x + 12;
  if (lg) { s += logo(lg, x+10, y+(h-logoSize)/2, logoSize); tx = x + 10 + logoSize + 9; }
  if (sub) { s += `<text class="tname" x="${tx}" y="${y+h/2-3}" style="font-size:12.5px">${esc(name)}</text><text class="sub sm" x="${tx}" y="${y+h/2+13}">${esc(sub)}</text>`; }
  else s += `<text class="tname" x="${tx}" y="${y+h/2+4.5}" style="font-size:12.5px">${esc(name)}</text>`;
  return s;
}
function cyl({ x,y,w,h, kind, name, sub, logo:lg }) {
  const ry = 11, rx = w/2;
  return `<g class="${kind}"><path class="cyl" d="M${x},${y+ry} v${h-2*ry} a${rx},${ry} 0 0 0 ${w},0 v${-(h-2*ry)}" /><ellipse class="cyltop" cx="${x+rx}" cy="${y+ry}" rx="${rx}" ry="${ry}"/>
<path class="cyl" fill="none" d="M${x},${y+ry} v${h-2*ry} a${rx},${ry} 0 0 0 ${w},0 v${-(h-2*ry)}"/></g>` +
  `<text class="mono" x="${x+rx}" y="${y+ry+30}" text-anchor="middle">${esc(name)}</text>` +
  (sub ? `<text class="sub sm" x="${x+rx}" y="${y+ry+46}" text-anchor="middle">${esc(sub)}</text>` : "") +
  (lg ? `<rect class="logobg" x="${x+rx-15}" y="${y+h-ry-28}" width="30" height="30" rx="7"/>` + logo(lg, x+rx-11, y+h-ry-24, 22) : "");
}
// arête: pts = [[x,y],...] ; type data|ctl|lin|deny
function edge(pts, type="data", label, lx, ly, opts={}) {
  const d = "M" + pts.map(p => p.join(",")).join(" L");
  let s = `<g class="edge ${type}"><path d="${d}" marker-end="url(#AH-${type}#)"${opts.both?` marker-start="url(#AS-${type}#)"`:""}/></g>`;
  if (label) s += `<text class="elabel${opts.onbg?" onbg":""}" x="${lx}" y="${ly}" text-anchor="${opts.anchor||"middle"}">${esc(label)}</text>`;
  return s;
}
const pill = (x,y,w,h,text,cls="") => `<rect class="pill ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h/2}"/><text class="ptxt" x="${x+w/2}" y="${y+h/2+4.5}" text-anchor="middle">${esc(text)}</text>`;
const text = (x,y,s,cls="sub",anchor="start") => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(s)}</text>`;
function legend(x, y, items) { // items: [{type, label}] ; type data|ctl|lin|deny|opt
  let s = "", cx = x;
  for (const it of items) {
    if (it.type === "opt") s += `<rect x="${cx}" y="${y-9}" width="30" height="18" rx="5" fill="none" stroke="currentColor" class="card opt" style="fill:none"/>`;
    else s += edge([[cx,y],[cx+34,y]], it.type);
    s += `<text class="legend" x="${cx+44}" y="${y+4}">${esc(it.label)}</text>`;
    cx += 44 + it.label.length * 6.6 + 26;
  }
  return s;
}
module.exports = { THEMES, doc, lane, card, chip, cyl, edge, pill, text, legend, logo, esc, SANS, MONO };
// badge numéroté (couche du TdR) — coin haut-droit d'un élément
module.exports.badge = (label, rx, ty) => { const w = 22 + (String(label).length-1)*7; const x = rx - w; return `<rect class="num" x="${x}" y="${ty}" width="${w}" height="20" rx="10"/><text class="numt" x="${x+w/2}" y="${ty+14}" text-anchor="middle">${esc(label)}</text>`; };
