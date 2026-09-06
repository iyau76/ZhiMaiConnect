import { spawn } from "node:child_process";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// JAVA_HOME / ANDROID_HOME / GRADLE_USER_HOME belong to the build environment.
// Debug APKs are for sideload testing; store releases need a separately managed signing key.
const android = resolve("android");
const command = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
await new Promise((accept, reject) => {
  const child = spawn(command, ["assembleDebug", "--no-daemon", "--max-workers=2"], {
    cwd: android,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? accept() : reject(new Error(`Android build exited ${code}`)),
  );
});
await mkdir("release/android", { recursive: true });
const metadata = JSON.parse(
  await readFile(resolve(android, "app/build/outputs/apk/debug/output-metadata.json"), "utf8"),
);
const output = `release/android/ZhiMai-Connect-${metadata.elements[0].versionName}-test.apk`;
await copyFile(resolve(android, "app/build/outputs/apk/debug/app-debug.apk"), output);
console.log(`APK: ${output}`);
