import { Camera, Loader2, Maximize2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { captureFrame } from "@/lib/vision-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function normalizeHost(raw: string) {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

type Status = "idle" | "connecting" | "online" | "offline";

interface CameraPanelProps {
  host: string;
  onHostChange: (host: string) => void;
  frame: string | null;
  onFrame: (frame: string | null) => void;
}

export function CameraPanel({ host, onHostChange, frame, onFrame }: CameraPanelProps) {
  const [draft, setDraft] = useState(host);
  const [status, setStatus] = useState<Status>("idle");
  const [nonce, setNonce] = useState(0);
  const [snapshotSrc, setSnapshotSrc] = useState("");
  const [capturing, setCapturing] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(host), [host]);

  const base = useMemo(() => normalizeHost(host), [host]);
  const src = snapshotSrc;

  useEffect(() => {
    if (base) setStatus("connecting");
  }, [base, nonce]);

  // 轮询快照：上一张加载完立刻取下一张（链式预加载），尽量贴近实时
  useEffect(() => {
    if (!base) {
      setSnapshotSrc("");
      return;
    }
    let alive = true;
    let timer = 0;
    let current: HTMLImageElement | null = null;

    const next = () => {
      if (!alive) return;
      const img = new Image();
      current = img;
      img.decoding = "async";
      img.onload = () => {
        if (!alive) return;
        setSnapshotSrc(img.src);
        setStatus("online");
        timer = window.setTimeout(next, 0);
      };
      img.onerror = () => {
        if (!alive) return;
        setStatus("offline");
        timer = window.setTimeout(next, 800);
      };
      img.src = `${base}/capture?_t=${Date.now()}`;
    };

    next();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      if (current) {
        current.onload = null;
        current.onerror = null;
      }
    };
  }, [base, nonce]);


  const applyHost = () => {
    const next = normalizeHost(draft);
    if (!next) {
      toast.error(t("请填写摄像头 IP"));
      return;
    }
    onHostChange(next);
    setNonce((n) => n + 1);
  };

  const handleCapture = async () => {
    if (!base) return;
    setCapturing(true);
    try {
      onFrame(await captureFrame(base));
      toast.success(t("已抓取当前画面"));
    } catch (error) {
      toast.error(`抓帧失败：${(error as Error).message}`);
    } finally {
      setCapturing(false);
    }
  };

  const statusMeta: Record<Status, { label: string; dot: string; icon: typeof Wifi }> = {
    idle: { label: t("未连接"), dot: "bg-muted-foreground", icon: WifiOff },
    connecting: { label: t("连接中"), dot: "bg-warning animate-pulse", icon: Wifi },
    online: { label: t("在线"), dot: "bg-success", icon: Wifi },
    offline: { label: t("连接失败"), dot: "bg-destructive", icon: WifiOff },
  };
  const meta = statusMeta[status];
  const StatusIcon = meta.icon;

  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5">
          <span className="font-display text-xl leading-none tracking-tight">{t("摄像头画面")}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Live
          </span>
        </h2>
        <span className="flex items-center gap-2 text-[11px] tracking-wide text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", meta.dot)} aria-hidden="true" />
          <StatusIcon className="size-3.5" aria-hidden="true" />
          {meta.label}
        </span>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label
            htmlFor="camera-host"
            className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground"
          >{t("设备地址")}</Label>
          <Input
            id="camera-host"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && applyHost()}
            placeholder="192.168.43.70"
            className="border-0 border-b border-border bg-transparent px-0 font-mono text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <Button onClick={applyHost} variant="outline" size="sm" className="shrink-0 rounded-full px-4">{t("加载地址")}</Button>
      </div>


      <div
        ref={shellRef}
        className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black"
      >
        {src ? (
          <img
            key="snapshot"
            src={src}
            alt={t("ESP32 摄像头实时画面")}
            className="size-full object-contain"
            onLoad={() => setStatus("online")}
            onError={() => setStatus("offline")}
          />
        ) : (
          <div className="flex size-full items-center justify-center px-6 text-center font-display text-lg italic text-muted-foreground">{t("填写 IP 后点击「加载地址」")}</div>
        )}

        {status === "offline" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-6 text-center">
            <p className="font-display text-xl">{t("连不上摄像头")}</p>
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{t("请确认此设备和 ESP32 在同一 WiFi、IP 没有变化，并试试切换到「轮询快照」模式。")}</p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border px-3 py-1 text-[11px] tracking-wide text-muted-foreground">
          {t("轮询快照")}
        </span>


        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          disabled={!base}
          className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />{t("重连")}</button>
        <button
          type="button"
          onClick={() => shellRef.current?.requestFullscreen?.()}
          disabled={!base}
          className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Maximize2 className="size-3.5" aria-hidden="true" />{t("全屏")}</button>

        <Button
          size="sm"
          onClick={handleCapture}
          disabled={!base || capturing}
          className="ml-auto rounded-full px-4"
        >
          {capturing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Camera className="size-3.5" aria-hidden="true" />
          )}
          {t("抓取当前帧")}
        </Button>
      </div>

      {frame && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-2">
          <img src={frame} alt={t("待提问的画面")} className="h-16 w-24 rounded-lg object-cover" />
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{t("这一帧会随下一个问题发给模型。")}</div>
          <Button variant="ghost" size="sm" onClick={() => onFrame(null)}>{t("清除")}</Button>
        </div>
      )}

    </section>
  );
}
