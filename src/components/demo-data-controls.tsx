import { Database, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { clearDemoData, getDemoDataStatus, loadDemoData } from "@/lib/demo-data";
import { getLang, t } from "@/lib/i18n";

export function DemoDataControls() {
  const [status, setStatus] = useState({ people: 0, relations: 0 });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setStatus(await getDemoDataStatus()), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const load = async () => {
    setBusy(true);
    try {
      const result = await loadDemoData();
      await refresh();
      toast.success(
        getLang() === "en"
          ? `Loaded ${result.people} synthetic people and ${result.relations} relationships`
          : `已载入 ${result.people} 位合成人物、${result.relations} 条关系`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "载入演示数据失败");
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4 text-primary" aria-hidden="true" />
          {t("竞赛演示数据")}
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "一键载入 50 位虚构人物、80 条关系及配套事件。所有邮箱使用 example.invalid，界面和来源均标注为合成数据，不对应真实个人。",
          )}
        </p>
      </div>
      <p className="text-xs">
        {t("当前已载入")}：{status.people} {t("人")} · {status.relations} {t("条关系")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void load()} disabled={busy}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Database className="size-4" aria-hidden="true" />
          )}
          {t("一键载入/重置合成数据")}
        </Button>
        {status.people > 0 && (
          <Button variant="outline" onClick={() => void clear()} disabled={busy}>
            <Trash2 className="size-4" aria-hidden="true" />
            {t("只清除合成数据")}
          </Button>
        )}
      </div>
    </section>
  );
}
