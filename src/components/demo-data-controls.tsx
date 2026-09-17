import { Database, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { DemoScenarioPicker } from "@/components/demo-scenario-picker";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { facesDb } from "@/lib/face-db";
import { clearDemoData, getDemoDataStatus } from "@/lib/demo-data";
import { t } from "@/lib/i18n";

/** 格式化后要一并清掉的本地状态；模型配置、语言与外观偏好保留。 */
const RESET_LOCAL_KEYS = [
  "zhimai.intake.draft.v1",
  "zhimai.agent-runs.v1",
  "openglass.welcomeSeen",
  "openglass.officer",
];

export function DemoDataControls() {
  const [status, setStatus] = useState({ people: 0, relations: 0 });
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const refresh = useCallback(async () => setStatus(await getDemoDataStatus()), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clear = async () => {
    if (!window.confirm(t("只会删除带“合成演示数据”标识的记录，不影响你自己录入的资料。继续？"))) {
      return;
    }
    setBusy(true);
    try {
      await clearDemoData();
      await refresh();
      toast.success("合成演示数据已清除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清除演示数据失败");
    } finally {
      setBusy(false);
    }
  };

  const formatArchive = async () => {
    setResetBusy(true);
    try {
      await facesDb.wipeDatabase();
      for (const key of RESET_LOCAL_KEYS) window.localStorage.removeItem(key);
      window.sessionStorage.clear();
      window.location.replace("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "格式化档案失败");
      setResetBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4 text-primary" aria-hidden="true" />
          {t("竞赛演示数据")}
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "选择校园、家庭、职场或小企业场景，也可以载入完整关系库。切换场景会替换上一套合成资料，不影响你自己录入的内容。",
          )}
        </p>
      </div>
      <p className="text-xs">
        {t("当前已载入")}：{status.people} {t("人")} · {status.relations} {t("条关系")}
      </p>
      <DemoScenarioPicker
        onLoaded={() => {
          void refresh();
        }}
      />
      <div className="flex flex-wrap gap-2">
        {status.people > 0 && (
          <Button variant="outline" onClick={() => void clear()} disabled={busy}>
            <Trash2 className="size-4" aria-hidden="true" />
            {t("只清除合成数据")}
          </Button>
        )}
        <Button variant="outline" onClick={() => setResetOpen(true)} disabled={resetBusy}>
          <Trash2 className="size-4" aria-hidden="true" />
          {t("格式化档案")}
        </Button>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent data-testid="format-archive-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("格式化档案，清空全部数据？")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "将删除所有人物、关系、事件、提醒、计划、圈层、证据、录入草稿与 AI 运行记录，回到初次打开的样子。模型配置与密钥、语言、外观偏好会保留。此操作不可撤销。",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetBusy}>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={resetBusy}
              onClick={(event) => {
                event.preventDefault();
                void formatArchive();
              }}
            >
              {resetBusy ? t("格式化中…") : t("确认格式化")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
