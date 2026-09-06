import { useCallback, useEffect, useState } from "react";
import { FileInput, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { listCaptures, removeCapture, type LocalCapture } from "@/lib/local-capture-store";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";

export function LocalCaptureInbox({
  revision,
  disabled,
  onImport,
}: {
  revision: number;
  disabled: boolean;
  onImport: (capture: LocalCapture) => Promise<void>;
}) {
  const [records, setRecords] = useState<LocalCapture[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRecords(await listCaptures());
      setError(null);
    } catch {
      setError("无法读取本机待整理材料，请检查存储权限。");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh, revision]);
  if (!records.length && !error) return null;
  return (
    <section
      aria-label={t("待整理材料")}
      className="mb-4 space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <h3 className="font-semibold">
        {t("待整理材料")} · {records.length}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(
          "已保存在本机，尚未发送给 AI。图片和扫描件使用当前模型识别，录音使用转写服务；读取后仍需确认入库。",
        )}
      </p>
      {error && <p role="alert">{t(error)}</p>}
      {records.map((capture) => (
        <div
          key={capture.id}
          className="flex flex-wrap items-center gap-2 border-t border-border pt-3"
        >
          <div className="min-w-0 flex-1 basis-40">
            <p className="truncate text-sm font-medium">
              {capture.title || capture.files[0]?.name || t("分享的材料")}
            </p>
            <p className="line-clamp-2 break-words text-sm text-muted-foreground">
              {capture.text || capture.files.map((file) => file.name).join("、")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {new Date(capture.createdAt).toLocaleString()}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={disabled || busy !== null}
            onClick={async () => {
              setBusy(capture.id);
              try {
                await onImport(capture);
                await removeCapture(capture.id);
                await refresh();
              } catch (caught) {
                toast.error((caught as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            <FileInput className="size-4" />
            {busy === capture.id ? t("正在读取") : t("放入录入框")}
          </Button>
          <Button
            variant="ghost"
            aria-label={`${t("删除材料")}：${capture.title || capture.files[0]?.name}`}
            disabled={disabled || busy !== null}
            onClick={async () => {
              try {
                await removeCapture(capture.id);
                await refresh();
              } catch (caught) {
                toast.error((caught as Error).message);
              }
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
    </section>
  );
}
