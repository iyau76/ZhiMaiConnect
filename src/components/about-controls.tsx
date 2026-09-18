/** 设置页的「关于」：显示当前版本，并以 GitHub Releases 为更新源检查新版本。 */

import { useState } from "react";
import { Download, Github, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/app-version";
import { t } from "@/lib/i18n";
import { platformFetch } from "@/lib/native-runtime";
import {
  RELEASES_PAGE_URL,
  checkForAppUpdate,
  currentPlatform,
  type UpdateCheckResult,
} from "@/lib/update-check";

const PLATFORM_LABEL: Record<ReturnType<typeof currentPlatform>, string> = {
  windows: "Windows 应用",
  android: "Android 应用",
  web: "网页版",
};

function noteExcerpt(notes: string) {
  const text = notes.replace(/\r/g, "").trim();
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function AboutControls() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const check = async () => {
    setChecking(true);
    try {
      setResult(
        await checkForAppUpdate({
          currentVersion: APP_VERSION,
          platform: currentPlatform(),
          // 原生壳走自带网络栈，网页版直接 fetch；这里只做参数收窄。
          fetchImpl: (input, init) => platformFetch(String(input), init),
        }),
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-5"
      aria-label={t("关于与更新")}
      data-testid="about-controls"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Info className="size-5" />
        {t("关于与更新")}
      </h2>
      <p className="text-sm" data-testid="app-version">
        {t("当前版本")} v{APP_VERSION} · {t(PLATFORM_LABEL[currentPlatform()])}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          "新版本发布在 GitHub Releases。检查更新只读取公开的版本信息，不上传本机资料；连不上时可以直接打开发布页手动下载。",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={checking} onClick={() => void check()}>
          <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
          {checking ? t("正在检查…") : t("检查新版本")}
        </Button>
        <Button variant="outline" asChild>
          <a href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
            <Github className="size-4" />
            {t("打开发布页")}
          </a>
        </Button>
      </div>

      {result?.status === "update" && (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-sm font-medium" data-testid="update-available">
            {t("发现新版本")} {result.release?.tag}（{t("当前")} v{result.currentVersion}）
          </p>
          {result.asset ? (
            <Button size="sm" asChild>
              <a href={result.asset.url} target="_blank" rel="noreferrer">
                <Download className="size-4" />
                {t("下载安装包")} · {result.asset.name}
              </a>
            </Button>
          ) : (
            <p className="text-sm" data-testid="update-no-asset">
              {currentPlatform() === "web"
                ? t("网页版打开时就会用上新版本；上面的「检查应用更新」可以手动触发。")
                : t("这个版本没有对应平台的安装包，请到发布页选择。")}
            </p>
          )}
          {result.release?.notes && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer py-1">{t("更新说明")}</summary>
              <p className="whitespace-pre-wrap">{noteExcerpt(result.release.notes)}</p>
            </details>
          )}
        </div>
      )}

      {result?.status === "latest" && (
        <p role="status" className="text-sm" data-testid="update-latest">
          {t("已是最新版本")} v{result.release?.version ?? result.currentVersion}
          {result.release?.prerelease ? `（${t("预发布")}）` : ""}
        </p>
      )}

      {result?.status === "unknown" && (
        <p role="alert" className="text-sm text-destructive" data-testid="update-unknown">
          {t("没能查到这个版本：")}
          {result.reason} · {t("可以打开发布页手动核对。")}
        </p>
      )}
    </section>
  );
}
