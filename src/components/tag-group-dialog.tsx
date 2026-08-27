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
import type { PersonRecord } from "@/lib/face-db";
import { t } from "@/lib/i18n";

interface Props {
  tag: string | null;
  members: PersonRecord[];
  candidates: PersonRecord[];
  onOpenChange: (open: boolean) => void;
  onRename: (from: string, to: string) => Promise<void> | void;
  onAddMember: (personId: string, tag: string) => Promise<void> | void;
  onRemoveMember: (personId: string, tag: string) => Promise<void> | void;
  onOpenPerson?: (person: PersonRecord) => void;
}

export function TagGroupDialog({
  tag,
  members,
  candidates,
  onOpenChange,
  onRename,
  onAddMember,
  onRemoveMember,
  onOpenPerson,
}: Props) {
  const [name, setName] = useState("");
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [updatingMember, setUpdatingMember] = useState<string | null>(null);

  useEffect(() => {
    if (!tag) return;
    setName(tag);
    setPick("");
    setUpdatingMember(null);
  }, [tag]);

  const save = async () => {
    if (!tag) return;
    const next = name.trim();
    if (!next) {
      toast.error(t("请输入标签名称"));
      return;
    }

    setSaving(true);
    try {
      if (next !== tag) await onRename(tag, next);
      toast.success(t("圈层已保存"));
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addMember = async () => {
    if (!pick || !tag) return;
    setUpdatingMember(pick);
    try {
      await onAddMember(pick, tag);
      setPick("");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setUpdatingMember(null);
    }
  };

  const removeMember = async (personId: string) => {
    if (!tag) return;
    setUpdatingMember(personId);
    try {
      await onRemoveMember(personId, tag);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setUpdatingMember(null);
    }
  };

  return (
    <Dialog open={!!tag} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{tag ?? ""}</DialogTitle>
          <DialogDescription>
            {members.length} {t("人")} · {t("可以重命名标签，也可以增减圈层成员")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-group-name">{t("圈层标签名称")}</Label>
            <Input
              id="tag-group-name"
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("成员列表")}</Label>
            {members.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("这个圈层还没有人")}</p>
            ) : (
              <ul className="space-y-1.5">
                {members.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpenPerson?.(member)}
                    >
                      <span className="block truncate text-sm">{member.name}</span>
                      {(member.profile?.relation || member.note) && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {member.profile?.relation || member.note}
                        </span>
                      )}
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0 text-muted-foreground"
                      disabled={updatingMember === member.id}
                      aria-label={`${t("从圈层移除")} ${member.name}`}
                      title={t("从圈层移除")}
                      onClick={() => void removeMember(member.id)}
                    >
                      <UserMinus className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tag-group-add">{t("加入成员")}</Label>
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("没有可加入的其他人物")}</p>
            ) : (
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <select
                  id="tag-group-add"
                  value={pick}
                  onChange={(event) => setPick(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">{t("选择一个人")}</option>
                  {candidates.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={!pick || updatingMember === pick}
                  onClick={() => void addMember()}
                >
                  <UserPlus className="size-4" aria-hidden="true" />
                  {t("加入")}
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("取消")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
