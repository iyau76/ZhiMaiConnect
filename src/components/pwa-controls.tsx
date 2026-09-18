import { Smartphone } from "lucide-react";
import { t } from "@/lib/i18n";
import { isNativeRuntime } from "@/lib/native-runtime";
import { usePwaState } from "@/lib/pwa-client";

export function PwaNotice() {
  const { online, updateReady } = usePwaState();
  if (online && !updateReady) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      {!online && (
        <p>{t("当前离线：可以记下材料、查看和编辑本机资料。AI 整理需要联网后点击继续。")}</p>
      )}
      {updateReady && <p>{t("新版本已下载。保存工作后关闭所有知脉窗口，再打开即可更新。")}</p>}
    </div>
  );
}

/** 网页版的安装按钮与存储按钮已下线，安装说明移到「关于与更新」底部。 */
export function PwaSettings() {
  if (!isNativeRuntime()) return null;
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Smartphone className="size-5" />
        {t("本机应用")}
      </h2>
      <p className="text-sm">
        {t("页面资源已随安装包提供，可断网查看和编辑。模型请求直接发送到你配置的接口。")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          "资料保存在当前应用中，与浏览器和其他设备独立。卸载前请导出完整备份，未整理材料需另存。",
        )}
      </p>
    </section>
  );
}
