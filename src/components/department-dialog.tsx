import { UserMinus, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getDepartmentNote, renameDepartmentNote, setDepartmentNote } from "@/lib/department-store";
import type { PersonRecord } from "@/lib/face-db";
import { t } from "@/lib/i18n";

interface Props {
  /** 当前打开的部门名；null 表示关闭 */
  department: string | null;
  /** 该部门下的人 */
  members: PersonRecord[];
  /** 其它部门 / 未分部门的人，可以直接调进来 */
  candidates: PersonRecord[];
  onOpenChange: (open: boolean) => void;
  /** 改名：把该部门下所有人改到新部门（空字符串 = 未分部门） */
  onRename: (from: string, to: string) => Promise<void> | void;
  /** 把某个人调入本部门 */
  onAddMember: (personId: string, department: string) => Promise<void> | void;
  /** 把某个人移出本部门（回到未分部门） */
  onRemoveMember: (personId: string) => Promise<void> | void;
  /** 点成员名字打开人物卡 */
  onOpenPerson?: (person: PersonRecord) => void;
}

export function DepartmentDialog({
  department,
  members,
  candidates,
  onOpenChange,
  onRename,
  onAddMember,
  onRemoveMember,
  onOpenPerson,
}: Props) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState("");

  useEffect(() => {
    if (!department) return;
    setName(department === t("未分部门") ? "" : department);
    setNote(getDepartmentNote(department));
    setPick("");
  }, [department]);

  const save = async () => {
    if (!department) return;
    setSaving(true);
    try {
      const next = name.trim();
      const target = next || t("未分部门");
      if (target !== department) {
        await onRename(department, next);
        renameDepartmentNote(department, target);
      }
      setDepartmentNote(target, note);
      toast.success(t("部门信息已保存"));
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unassigned = t("未分部门");

  return (
    <Dialog open={!!department} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{department ?? ""}</DialogTitle>
          <DialogDescription>
            {members.length} {t("人")} · {t("可以改部门名、写介绍，也可以增减成员")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="dept-name">{t("部门名称")}</Label>
            <Input
              id="dept-name"
              value={name}
              placeholder={t("留空表示未分部门")}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dept-note">{t("部门介绍")}</Label>
            <Textarea
              id="dept-note"
              rows={4}
              value={note}
              placeholder={t("这个部门负责什么、有哪些主要项目…")}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("成员列表")}</Label>
            {members.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t("这个部门还没有人")}</p>
            ) : (
              <ul className="space-y-1">
                {members.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onOpenPerson?.(member)}
                    >
                      <span className="text-sm">{member.name}</span>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        {member.profile?.title || t("暂无职位")}
                      </span>
                    </button>
                    {department !== unassigned && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-muted-foreground"
                        title={t("移出该部门")}
                        onClick={() => void onRemoveMember(member.id)}
                      >
                        <UserMinus className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {department !== unassigned && candidates.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="dept-add">{t("加入成员")}</Label>
              <div className="flex gap-2">
                <select
                  id="dept-add"
                  value={pick}
                  onChange={(event) => setPick(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">{t("选择一个人")}</option>
                  {candidates.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.profile?.department ? ` · ${person.profile.department}` : ""}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={!pick}
                  onClick={async () => {
                    if (!pick || !department) return;
                    await onAddMember(pick, department);
                    setPick("");
                  }}
                >
                  <UserPlus className="size-3.5" aria-hidden="true" />
                  {t("加入")}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("取消")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
