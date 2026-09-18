/**
 * 版本号单一来源：根 package.json。
 *
 * 以前三个渠道各写各的（根 package.json 0.1.0、desktop/package.json 0.3.1、
 * android/app/build.gradle 0.3.1），「检查更新」就没有可信的当前版本可比。
 * 这个脚本把它们对齐，并把版本写进 src/lib/app-version.ts。
 *
 * 用法：
 *   node scripts/sync-version.mjs            按根 package.json 同步其它文件
 *   node scripts/sync-version.mjs --check    只校验是否一致（不一致退出码 1）
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const checkOnly = process.argv.includes("--check");

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, root), "utf8"));
}

const version = readJson("package.json").version;
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`根 package.json 的版本号不合法：${version}`);

const mismatches = [];
function syncFile(relativePath, transform) {
  const url = new URL(relativePath, root);
  const before = readFileSync(url, "utf8");
  const after = transform(before);
  if (before === after) return;
  mismatches.push(relativePath);
  if (!checkOnly) writeFileSync(url, after, "utf8");
}

syncFile("desktop/package.json", (text) => {
  const pkg = JSON.parse(text);
  if (pkg.version === version) return text;
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

syncFile("android/app/build.gradle", (text) => {
  const currentName = /versionName "([^"]+)"/.exec(text)?.[1];
  const currentCode = Number.parseInt(/versionCode (\d+)/.exec(text)?.[1] ?? "", 10);
  const nextCode =
    currentName === version || !Number.isFinite(currentCode) ? currentCode : currentCode + 1;
  return text
    .replace(/versionName "[^"]+"/, `versionName "${version}"`)
    .replace(/versionCode \d+/, `versionCode ${Number.isFinite(nextCode) ? nextCode : 1}`);
});

syncFile("src/lib/app-version.ts", (text) =>
  text.replace(/export const APP_VERSION = "[^"]*";/, `export const APP_VERSION = "${version}";`),
);

if (checkOnly) {
  if (mismatches.length) {
    console.error(`版本号不一致，请运行 node scripts/sync-version.mjs：${mismatches.join("、")}`);
    process.exit(1);
  }
  console.log(`版本号已对齐：${version}`);
} else if (mismatches.length) {
  console.log(`已把版本号同步到 ${version}：${mismatches.join("、")}`);
} else {
  console.log(`版本号本来就是 ${version}，无需改动`);
}
