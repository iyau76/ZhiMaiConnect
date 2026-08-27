import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL("../.output/server/wrangler.json", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));

// Keep deployments on the existing public Worker instead of Nitro's generated
// package-derived name (which would create a second workers.dev hostname).
config.name = "zhimai-connect";
// Build machines in UTC+8 can enter a new calendar day before Cloudflare's
// control plane. Pin a known-supported date so evening deployments are valid.
config.compatibility_date = "2026-08-27";

// Stable namespace IDs intentionally live in source control. They are identifiers,
// not credentials; keeping them stable preserves counters across deployments.
config.ratelimits = [
  {
    name: "ZHIMAI_TRANSCRIBE_LIMITER",
    namespace_id: "824011",
    simple: { limit: 10, period: 60 },
  },
  {
    name: "ZHIMAI_VISION_LIMITER",
    namespace_id: "824012",
    simple: { limit: 30, period: 60 },
  },
  {
    name: "ZHIMAI_WEB_TOOLS_LIMITER",
    namespace_id: "824013",
    simple: { limit: 24, period: 60 },
  },
];

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log("Configured Cloudflare edge rate-limit bindings.");
