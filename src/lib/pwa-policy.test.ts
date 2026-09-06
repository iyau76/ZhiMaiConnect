import { describe, expect, it } from "vitest";
import { isAppNavigation, isPrecachedAsset } from "./pwa-policy";

const origin = "https://zhimai.example";
const assets = ["/assets/app-abc.js", "/manifest.webmanifest"];
describe("PWA public cache boundary", () => {
  it("serves the same local shell for workspace deep links", () => {
    expect(
      isAppNavigation(new URL("/?view=intake&shared=1", origin), "navigate", "GET", origin),
    ).toBe(true);
  });
  it.each([
    "/api/vision",
    "/api/status",
    "/api/transcribe",
    "/api/web-tools",
    "/share-target",
    "/other",
  ])("never treats %s as the app shell", (path) => {
    expect(isAppNavigation(new URL(path, origin), "navigate", "GET", origin)).toBe(false);
  });
  it("caches only exact same-origin public build assets", () => {
    expect(isPrecachedAsset(new URL("/assets/app-abc.js", origin), "GET", origin, assets)).toBe(
      true,
    );
    for (const path of [
      "/api/vision",
      "/assets/app-abc.js?token=private",
      "https://model.example/assets/app-abc.js",
    ]) {
      expect(isPrecachedAsset(new URL(path, origin), "GET", origin, assets)).toBe(false);
    }
    expect(isPrecachedAsset(new URL(assets[0], origin), "POST", origin, assets)).toBe(false);
  });
});
