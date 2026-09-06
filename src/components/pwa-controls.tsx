import { useState } from "react";
import { Download, RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { checkPwaUpdate, installPwa, usePwaState } from "@/lib/pwa-client";
import { t } from "@/lib/i18n";
import { isNativeRuntime } from "@/lib/native-runtime";

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

export function PwaSettings() {
  const state = usePwaState();
  const [storageMessage, setStorageMessage] = useState("");
  const [checking, setChecking] = useState(false);
  if (isNativeRuntime())
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
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-5"
      aria-label={t("安装与本机存储")}
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Smartphone className="size-5" />
        {t("安装到手机或电脑")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("免登录使用，人物和事件保存在当前设备。首次打开并完成离线准备后，可以断网查看和编辑。")}
      </p>
      <p className="text-sm" data-testid="pwa-ready">
        {state.offlineReady ? t("离线资源已就绪") : t("离线资源尚未就绪")}
        {state.installed ? ` · ${t("已安装")}` : ""}
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(state.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!state.installed && state.installable && (
          <Button
            onClick={() => void installPwa().catch((error: Error) => toast.error(error.message))}
          >
            <Download className="size-4" />
            {t("安装知脉")}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={checking || !state.online}
          onClick={async () => {
            setChecking(true);
            try {
              await checkPwaUpdate();
              toast.success(t("已检查更新；下载完成后会显示提示。"));
            } catch (error) {
              toast.error((error as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          <RefreshCw className="size-4" />
          {t("检查应用更新")}
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              const retained = await navigator.storage?.persist?.();
              setStorageMessage(
                retained
                  ? "已获准持久保存。仍请定期导出完整备份。"
                  : "浏览器暂未授予持久保存，请定期导出完整备份。",
              );
            } catch {
              setStorageMessage("无法申请持久保存，请检查浏览器站点设置。");
            }
          }}
        >
          {t("申请保留本机数据")}
        </Button>
      </div>
      {storageMessage && (
        <p role="status" className="text-sm">
          {t(storageMessage)}
        </p>
      )}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer py-2">{t("安装方法与数据说明")}</summary>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            {t("Android Chrome / 桌面 Chrome、Edge：打开浏览器菜单，选择安装应用或添加到主屏幕。")}
          </li>
          <li>
            {t("iPhone：在浏览器分享菜单中选择添加到主屏幕。系统分享接收能力以浏览器支持为准。")}
          </li>
          <li>
            {t(
              "不同设备、浏览器和网站地址各有独立的本地资料。换设备或换网址前，在设置中导出 JSON 完整备份。",
            )}
          </li>
          <li>
            {t(
              "清理站点数据会删除资料和待整理材料。完整备份不包含未提交材料，请先整理或另存原文件。",
            )}
          </li>
          <li>
            {t("安装仍需网站可访问；AI 需要模型服务联网。当前没有云同步或关闭应用后的定时通知。")}
          </li>
        </ul>
      </details>
    </section>
  );
}
