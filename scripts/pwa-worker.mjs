// Build template. Generated imports are public, environment-independent modules.
import { captureText, saveCapture } from "./pwa/local-capture-store.js";
import { isAppNavigation, isPrecachedAsset } from "./pwa/pwa-policy.js";

const VERSION = "__PWA_VERSION__";
const ASSETS = __PWA_ASSETS__;
const CACHE = `zhimai-shell-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Install the HTML and all its assets as one release. A failed install leaves
      // the active worker untouched; no partial shell is ever activated.
      const shell = await fetch("/", { cache: "no-store", credentials: "omit" });
      if (!shell.ok || !shell.headers.get("content-type")?.includes("text/html")) {
        throw new Error("App shell unavailable");
      }
      const html = await shell.clone().text();
      const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)(?:\?[^ "]*)?"/g)].map(
        (m) => m[1],
      );
      if (
        !references.some((path) => path.endsWith(".js")) ||
        references.some((path) => !ASSETS.includes(path))
      ) {
        throw new Error("App shell and worker versions differ");
      }
      await cache.addAll(ASSETS);
      await cache.put("/", shell);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // No skipWaiting: the previous release remains in charge until every old
      // window is closed. This cannot interrupt a running Agent or edited draft.
      for (const name of await caches.keys()) {
        if (name.startsWith("zhimai-shell-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const text = captureText(
    String(form.get("title") ?? ""),
    String(form.get("text") ?? ""),
    String(form.get("url") ?? ""),
  );
  const files = form.getAll("files").filter((value) => value instanceof File && value.size > 0);
  try {
    await saveCapture({ title: String(form.get("title") ?? "分享的材料"), text, files });
    return Response.redirect(new URL("/?view=intake&shared=1", self.location.origin), 303);
  } catch (error) {
    // Plain text response, no interpolation into executable HTML; the original
    // share stays on the sender's device and can be sent again.
    return new Response(`材料未保存：${error.message}。请返回原应用后重试。`, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method === "POST" &&
    url.origin === self.location.origin &&
    url.pathname === "/share-target"
  ) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (isAppNavigation(url, request.mode, request.method, self.location.origin)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match("/"))
        .then((response) => response ?? fetch(request)),
    );
  } else if (isPrecachedAsset(url, request.method, self.location.origin, ASSETS)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match(url.pathname))
        .then((response) => response ?? fetch(request)),
    );
  }
});
