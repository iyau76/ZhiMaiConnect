import { useSyncExternalStore } from "react";
import { isNativeRuntime } from "./native-runtime";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaState {
  online: boolean;
  installed: boolean;
  installable: boolean;
  offlineReady: boolean;
  updateReady: boolean;
  error: string | null;
}

const INITIAL: PwaState = {
  online: true,
  installed: false,
  installable: false,
  offlineReady: false,
  updateReady: false,
  error: null,
};
let state = INITIAL;
let installPrompt: InstallPrompt | null = null;
let registration: ServiceWorkerRegistration | undefined;
let started = false;
const listeners = new Set<() => void>();
function publish(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function usePwaState() {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

export function startPwa() {
  if (started) return;
  started = true;
  const standalone = window.matchMedia("(display-mode: standalone)");
  const refreshNetwork = () => publish({ online: navigator.onLine });
  const refreshInstall = () =>
    publish({
      installed:
        standalone.matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    });
  refreshNetwork();
  refreshInstall();
  window.addEventListener("online", refreshNetwork);
  window.addEventListener("offline", refreshNetwork);
  standalone.addEventListener("change", refreshInstall);
  if (isNativeRuntime()) {
    publish({ installed: true, offlineReady: true });
    return;
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    publish({ installable: true });
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    publish({ installed: true, installable: false });
  });
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .register("/sw.js", { type: "module", scope: "/", updateViaCache: "none" })
    .then((value) => {
      registration = value;
      const refreshWorker = () =>
        publish({ offlineReady: Boolean(value.active), updateReady: Boolean(value.waiting) });
      refreshWorker();
      navigator.serviceWorker.addEventListener("controllerchange", refreshWorker);
      value.addEventListener("updatefound", () => {
        const worker = value.installing;
        worker?.addEventListener("statechange", () => {
          refreshWorker();
          if (worker.state === "redundant")
            publish({ error: "离线资源未能下载完成，请联网后检查更新。" });
        });
      });
      void navigator.serviceWorker.ready.then(refreshWorker);
    })
    .catch(() => publish({ error: "离线安装未完成，请确认网络连接后重新打开。" }));
}

export async function installPwa() {
  if (!installPrompt) return;
  const event = installPrompt;
  installPrompt = null;
  publish({ installable: false });
  await event.prompt();
}

export async function checkPwaUpdate() {
  if (!registration) throw new Error("当前尚未启用离线安装；请使用 HTTPS 正式构建或本机预览。");
  publish({ error: null });
  await registration.update();
}
