// Produces a real installed-cohort SBOM (name/version/license) from the
// actual node_modules tree for G01. Fails if a package.json is unreadable or
// the cohort is empty, so silent truncation cannot pass the license check.
import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const outPath = process.argv[2] ?? "artifacts/runtime/G01/sbom.json";
const paths = new Set([
  ...globSync("node_modules/.pnpm/*/node_modules/@*/*/package.json", { cwd: root }),
  ...globSync("node_modules/.pnpm/*/node_modules/*/package.json", { cwd: root }),
]);
if (paths.size === 0) throw new Error("no installed packages discovered — cohort empty");
const packages = [];
for (const rel of [...paths].sort()) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, rel), "utf8")); } catch (e) {
    throw new Error(`unreadable package.json ${rel}: ${e.message}`);
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error(`invalid package.json ${rel}`);
  let license = pkg.license;
  if (license === undefined) license = Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" AND ") : "UNKNOWN";
  packages.push({ name: pkg.name, version: pkg.version, license: typeof license === "string" && license ? license : "UNKNOWN", path: rel });
}
const digest = "sha256:" + createHash("sha256").update(JSON.stringify(packages.map((p) => [p.name, p.version, p.license]))).digest("hex");
writeFileSync(join(root, outPath), JSON.stringify({ generatedAt: new Date().toISOString(), cohortDigest: digest, count: packages.length, packages }, null, 2) + "\n");
const unknown = packages.filter((p) => p.license === "UNKNOWN").length;
console.log(`SBOM: ${packages.length} packages (${unknown} UNKNOWN license) -> ${outPath}`);
