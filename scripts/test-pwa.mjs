import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "e2e/pwa.spec.ts",
    "--workers=1",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_PWA_TEST: "1",
      PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? "4175",
    },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
