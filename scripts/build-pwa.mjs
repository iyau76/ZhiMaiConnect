import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../.output/public/", import.meta.url);
await mkdir(new URL("pwa/", root), { recursive: true });
for (const name of ["local-capture-store", "pwa-policy"]) {
  const source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  await writeFile(new URL(`pwa/${name}.js`, root), outputText);
}
const assets = (await readdir(new URL("assets/", root))).map((name) => `/assets/${name}`);
assets.push(
  "/manifest.webmanifest",
  "/favicon.png",
  "/icons/zhimai-384.png",
  "/icons/zhimai-1024.png",
  "/pwa/local-capture-store.js",
  "/pwa/pwa-policy.js",
);
assets.sort();
const template = await readFile(new URL("pwa-worker.mjs", import.meta.url), "utf8");
const hash = createHash("sha256").update(template);
for (const asset of assets) hash.update(asset).update(await readFile(new URL(`.${asset}`, root)));
const version = hash.digest("hex").slice(0, 16);
await writeFile(
  new URL("sw.js", root),
  template
    .replace('"__PWA_VERSION__"', JSON.stringify(version))
    .replace("__PWA_ASSETS__", JSON.stringify(assets)),
);
const headersPath = new URL("_headers", root);
const headers = await readFile(headersPath, "utf8");
await writeFile(
  headersPath,
  `${headers}\n/sw.js\n  Cache-Control: no-cache\n/pwa/*\n  Cache-Control: no-cache\n/manifest.webmanifest\n  Cache-Control: no-cache\n`,
);
console.log(`PWA ${version}: ${assets.length} public assets; API traffic excluded.`);
