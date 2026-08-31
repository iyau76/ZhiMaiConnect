/** 通用导出按钮：Markdown / Word / PDF */

import { Download, FileJson, FileText, FileType, Printer, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportData,
  previewMachineArchiveRestore,
  restoreMachineArchive,
  type ExportFormat,
  type ExportScope,
} from "@/lib/export-data";
import { t } from "@/lib/i18n";

const OPTIONS: Array<{ id: ExportFormat; label: string; icon: typeof FileText }> = [
  { id: "json", label: "完整备份 (.json)", icon: FileJson },
  { id: "md", label: "Markdown (.md)", icon: FileText },
  { id: "docx", label: "Word (.docx)", icon: FileType },
  { id: "pdf", label: "PDF（打印另存）", icon: Printer },
];

export function ExportMenu({ scope, className }: { scope: ExportScope; className?: string }) {
  const [busy, setBusy] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const run = async (format: ExportFormat) => {
    setBusy(true);
    try {
      const count = await exportData(scope, format);
      toast.success(
        format === "pdf"
          ? t("已打开打印预览，选择「另存为 PDF」即可")
          : `${t("已导出")} ${count} ${t("条记录")}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === "popup-blocked"
          ? t("浏览器拦截了新窗口，请允许弹窗后重试")
          : t("导出失败，请重试"),
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const preview = previewMachineArchiveRestore(text);
      const warning = preview.warnings.length ? `\n\n迁移提示：${preview.warnings.join("；")}` : "";
      if (
        !window.confirm(
          `将用「${file.name}」完整替换当前人物、关系、集合、证据、事件、提醒与事务（${preview.recordCount} 条）。\n\n恢复不会合并旧数据；${preview.discardedProjectionCount} 条导入投影快照会被丢弃，再从事实重新计算。${warning}\n\n确认继续吗？`,
        )
      )
        return;
      const result = await restoreMachineArchive(text);
      toast.success(`${t("恢复完成")}：${result.recordCount} ${t("条记录")}`);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("恢复失败"));
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy} className={className}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {busy ? t("导出中…") : t("导出")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {scope === "people" ? t("人物档案 + 关系") : t("事务清单")}
        </DropdownMenuLabel>
        {OPTIONS.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => void run(option.id)}>
            <option.icon className="mr-2 h-3.5 w-3.5 text-primary" />
            {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => restoreInputRef.current?.click()}>
          <Upload className="mr-2 h-3.5 w-3.5 text-primary" />
          {t("从完整备份恢复")}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <input
        ref={restoreInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => void restore(event.target.files?.[0])}
      />
    </DropdownMenu>
  );
}
