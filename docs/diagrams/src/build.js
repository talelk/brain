// Draws the diagrams of this folder as SVG and PNG, in a light and a dark theme: `npm install && node src/build.js`.
const fs = require("fs"), path = require("path");
const { Resvg } = require("@resvg/resvg-js");
const L = require("./lib");
const root = path.join(__dirname, "..");
const only = process.argv.slice(2);
for (const f of fs.readdirSync(__dirname).filter((name) => /^d\d\d-.*\.js$/.test(name)).sort()) {
  if (only.length && !only.some((o) => f.startsWith(o))) continue;
  const d = require("./" + f);
  for (const theme of ["light", "dark"]) {
    const svg = L.doc({ w: d.w, h: d.h, theme, title: d.title, desc: d.desc, body: d.build(theme) });
    const base = `${d.id}-${theme}`;
    fs.writeFileSync(path.join(root, "svg", base + ".svg"), svg);
    const png = new Resvg(svg, { fitTo: { mode: "width", value: d.w * 2 }, font: { loadSystemFonts: true, defaultFontFamily: "Noto Sans", monospaceFamily: "JetBrains Mono" } }).render().asPng();
    fs.writeFileSync(path.join(root, "png", base + ".png"), png);
  }
  console.log("ok", d.id);
}
