import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { PersonRecord, TaskRecord } from "@/lib/face-db";
import { t } from "@/lib/i18n";

export function TaskEditor({
  task,
  people,
  onSave,
  onClose,
}: {
  task: TaskRecord;
  people: PersonRecord[];
  onSave: (changes: Partial<TaskRecord>) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  const patch = (value: Partial<TaskRecord>) => setDraft((current) => ({ ...current, ...value }));
  const save = async () => {
    if (!draft.title.trim()) return;
    setSaving(true);
    try {
      await onSave({
        title: draft.title.trim(),
        detail: draft.detail?.trim() || undefined,
        due: draft.due || undefined,
        assignee: draft.assignee?.trim() || undefined,
        personIds: draft.personIds ?? [],
        priority: draft.priority,
        status: draft.status,
      });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("编辑任务")}</DialogTitle>
          <DialogDescription>{t("修改任务内容、时间与参与者。")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block space-y-1 text-sm">
            {t("任务标题")}
            <Input
              required
              value={draft.title}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("任务详情")}
            <Textarea
              value={draft.detail ?? ""}
              onChange={(event) => patch({ detail: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("截止日期")}
            <Input
              type="date"
              value={draft.due ?? ""}
              onChange={(event) => patch({ due: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("负责人")}
            <Input
              value={draft.assignee ?? ""}
              onChange={(event) => patch({ assignee: event.target.value })}
            />
          </label>
          <div className="flex gap-3">
            <label className="space-y-1 text-sm">
              {t("优先级")}
              <select
                className="block rounded border bg-background p-2"
                value={draft.priority}
                onChange={(event) =>
                  patch({ priority: event.target.value as TaskRecord["priority"] })
                }
              >
                <option value="high">{t("紧急")}</option>
                <option value="normal">{t("一般")}</option>
                <option value="low">{t("可延后")}</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              {t("状态")}
              <select
                className="block rounded border bg-background p-2"
                value={draft.status}
                onChange={(event) => patch({ status: event.target.value as TaskRecord["status"] })}
              >
                <option value="todo">{t("待办")}</option>
                <option value="doing">{t("进行中")}</option>
                <option value="done">{t("已完成")}</option>
              </select>
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm">{t("相关人物")}</legend>
            <div className="flex flex-wrap gap-3">
              {people.map((person) => (
                <label key={person.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.personIds?.includes(person.id) ?? false}
                    onChange={(event) =>
                      patch({
                        personIds: event.target.checked
                          ? [...(draft.personIds ?? []), person.id]
                          : (draft.personIds ?? []).filter((id) => id !== person.id),
                      })
                    }
                  />
                  {person.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t("取消")}
            </Button>
            <Button type="submit" disabled={saving || !draft.title.trim()}>
              {saving ? t("保存中…") : t("保存任务")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
