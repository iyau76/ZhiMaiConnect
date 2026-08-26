/** 事务 / 项目信息库：列出要推进的事务，以及各自的负责人与参与人 */

import { Briefcase, Plus, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ExportMenu } from "@/components/export-menu";
import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { facesDb, type PersonRecord, type ProjectRecord } from "@/lib/face-db";
import { t } from "@/lib/i18n";
import { makeSource } from "@/lib/provenance";
import { cn } from "@/lib/utils";

type Status = ProjectRecord["status"];
type Priority = ProjectRecord["priority"];

const STATUSES: Array<{ id: Status; label: string; tone: string }> = [
  { id: "planned", label: "待启动", tone: "bg-muted text-muted-foreground" },
  { id: "active", label: "进行中", tone: "bg-primary/12 text-primary" },
  { id: "blocked", label: "受阻", tone: "bg-destructive/12 text-destructive" },
  { id: "done", label: "已完成", tone: "bg-accent text-accent-foreground" },
];

const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: "high", label: "高" },
  { id: "normal", label: "中" },
  { id: "low", label: "低" },
];

function statusMeta(id: Status) {
  return STATUSES.find((item) => item.id === id) ?? STATUSES[0];
}

const EMPTY = {
  title: "",
  detail: "",
  department: "",
  ownerId: "",
  memberIds: [] as string[],
  status: "planned" as Status,
  priority: "normal" as Priority,
  due: "",
  tags: "",
};

export function ProjectsPanel() {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [keyword, setKeyword] = useState("");
  const [groupByOwner, setGroupByOwner] = useState(false);

  const reload = async () => {
    const [personRows, projectRows] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listProjects(),
    ]);
    setPeople(personRows);
    setProjects(projectRows);
  };

  useEffect(() => {
    reload().catch(() => toast.error(t("读取本地数据库失败")));
  }, []);

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const person of people) {
      const dept = person.profile?.department?.trim();
      if (dept) set.add(dept);
    }
    for (const project of projects) {
      if (project.department?.trim()) set.add(project.department.trim());
    }
    return [...set].sort();
  }, [people, projects]);

  const nameOf = (id?: string | null) =>
    people.find((person) => person.id === id)?.name ?? "";

  const reset = () => {
    setForm({ ...EMPTY });
    setEditingId(null);
  };

  const save = async () => {
    const title = form.title.trim();
    if (!title) {
      toast.error(t("先写一个事务名称"));
      return;
    }
    const existing = projects.find((project) => project.id === editingId);
    const record: ProjectRecord = {
      id: editingId ?? crypto.randomUUID(),
      title,
      detail: form.detail.trim() || undefined,
      department: form.department.trim() || undefined,
      ownerId: form.ownerId || null,
      ownerName: nameOf(form.ownerId) || undefined,
      memberIds: form.memberIds,
      status: form.status,
      priority: form.priority,
      due: form.due || undefined,
      tags: form.tags
        .split(/[,，、\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      source: existing?.source ?? makeSource("manual"),
    };
    await facesDb.putProject(record);
    toast.success(editingId ? t("已更新事务") : t("已加入事务库"));
    reset();
    await reload();
  };

  const edit = (project: ProjectRecord) => {
    setEditingId(project.id);
    setForm({
      title: project.title,
      detail: project.detail ?? "",
      department: project.department ?? "",
      ownerId: project.ownerId ?? "",
      memberIds: project.memberIds ?? [],
      status: project.status,
      priority: project.priority,
      due: project.due ?? "",
      tags: (project.tags ?? []).join("、"),
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (id: string) => {
    await facesDb.deleteProject(id);
    if (editingId === id) reset();
    await reload();
    toast.success(t("已删除"));
  };

  const cycleStatus = async (project: ProjectRecord) => {
    const index = STATUSES.findIndex((item) => item.id === project.status);
    const next = STATUSES[(index + 1) % STATUSES.length].id;
    await facesDb.putProject({ ...project, status: next, updatedAt: Date.now() });
    await reload();
  };

  const toggleMember = (id: string) => {
    setForm((prev) => ({
      ...prev,
      memberIds: prev.memberIds.includes(id)
        ? prev.memberIds.filter((item) => item !== id)
        : [...prev.memberIds, id],
    }));
  };

  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return projects.filter((project) => {
      if (filter !== "all" && project.status !== filter) return false;
      if (!word) return true;
      const haystack = [
        project.title,
        project.detail,
        project.department,
        project.ownerName ?? nameOf(project.ownerId),
        ...(project.tags ?? []),
        ...(project.memberIds ?? []).map((id) => nameOf(id)),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(word);
    });
  }, [projects, filter, keyword, people]);

  const byOwner = useMemo(() => {
    const map = new Map<string, { name: string; rows: ProjectRecord[] }>();
    for (const project of visible) {
      const key = project.ownerId || `name:${project.ownerName ?? ""}`;
      const name = nameOf(project.ownerId) || project.ownerName || t("未指定负责人");
      const bucket = map.get(key) ?? { name, rows: [] };
      bucket.rows.push(project);
      map.set(key, bucket);
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [visible, people]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: projects.length };
    for (const status of STATUSES) {
      result[status.id] = projects.filter((project) => project.status === status.id).length;
    }
    return result;
  }, [projects]);

  return (
    <section className="min-w-0 space-y-5">
      {/* 录入表单 */}
      <div className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <div className="mb-4 flex items-center gap-2">
          <Briefcase className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-medium">
            {editingId ? t("修改事务") : t("新增事务")}
          </h2>
          <ExportMenu scope="projects" className="ml-auto" />
        </div>


        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="project-title">{t("事务名称")}</Label>
            <Input
              id="project-title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder={t("如：Q3 客户回访计划")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-owner">{t("负责人")}</Label>
            <select
              id="project-owner"
              value={form.ownerId}
              onChange={(event) => setForm({ ...form, ownerId: event.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">{t("未指定")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                  {person.profile?.title ? ` · ${person.profile.title}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-dept">{t("归属部门")}</Label>
            <Input
              id="project-dept"
              list="project-dept-options"
              value={form.department}
              onChange={(event) => setForm({ ...form, department: event.target.value })}
              placeholder={t("可留空")}
            />
            <datalist id="project-dept-options">
              {departments.map((dept) => (
                <option key={dept} value={dept} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-due">{t("截止日期")}</Label>
              <Input
                id="project-due"
                type="date"
                value={form.due}
                onChange={(event) => setForm({ ...form, due: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-priority">{t("优先级")}</Label>
              <select
                id="project-priority"
                value={form.priority}
                onChange={(event) =>
                  setForm({ ...form, priority: event.target.value as Priority })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {PRIORITIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.label)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="project-detail">{t("事务说明")}</Label>
            <Textarea
              id="project-detail"
              rows={3}
              value={form.detail}
              onChange={(event) => setForm({ ...form, detail: event.target.value })}
              placeholder={t("要做什么、推进到哪一步、卡在哪里")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-tags">{t("标签")}</Label>
            <Input
              id="project-tags"
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
              placeholder={t("用顿号或逗号分隔")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("状态")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setForm({ ...form, status: item.id })}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition-colors",
                    form.status === item.id
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label>{t("参与人")}</Label>
            {people.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("人物库还是空的，先去「人物关系」里加人。")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {people.map((person) => {
                  const on = form.memberIds.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => toggleMember(person.id)}
                      className={cn(
                        "rounded-full px-3 py-1 text-xs transition-colors",
                        on
                          ? "bg-accent text-accent-foreground"
                          : "border border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {person.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void save()}>
            <Plus className="size-4" aria-hidden="true" />
            {editingId ? t("保存修改") : t("加入事务库")}
          </Button>
          {editingId && (
            <Button type="button" variant="ghost" onClick={reset}>
              {t("取消")}
            </Button>
          )}
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                filter === "all"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {t("全部")} {counts.all}
            </button>
            {STATUSES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  filter === item.id
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {t(item.label)} {counts[item.id] ?? 0}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t("搜事务、负责人、标签")}
              className="h-8 w-44 text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGroupByOwner((prev) => !prev)}
            >
              <Users className="size-3.5" aria-hidden="true" />
              {groupByOwner ? t("按事务") : t("按负责人")}
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("还没有事务，先在上面加一条。")}
          </p>
        ) : groupByOwner ? (
          <div className="mt-4 space-y-4">
            {byOwner.map((group) => (
              <div key={group.name} className="rounded-xl border border-border p-3">
                <p className="mb-2 text-sm font-medium">
                  {group.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {group.rows.length} {t("项")}
                  </span>
                </p>
                <div className="space-y-2">
                  {group.rows.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      nameOf={nameOf}
                      onEdit={edit}
                      onRemove={remove}
                      onCycle={cycleStatus}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {visible.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                nameOf={nameOf}
                onEdit={edit}
                onRemove={remove}
                onCycle={cycleStatus}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ProjectRow({
  project,
  nameOf,
  onEdit,
  onRemove,
  onCycle,
}: {
  project: ProjectRecord;
  nameOf: (id?: string | null) => string;
  onEdit: (project: ProjectRecord) => void;
  onRemove: (id: string) => Promise<void>;
  onCycle: (project: ProjectRecord) => Promise<void>;
}) {
  const meta = statusMeta(project.status);
  const owner = nameOf(project.ownerId) || project.ownerName;
  const members = (project.memberIds ?? []).map((id) => nameOf(id)).filter(Boolean);

  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          onClick={() => void onCycle(project)}
          className={cn("rounded-full px-2 py-0.5 text-[11px]", meta.tone)}
          title={t("点一下切换状态")}
        >
          {t(meta.label)}
        </button>
        <button
          type="button"
          onClick={() => onEdit(project)}
          className="min-w-0 flex-1 text-left text-sm hover:text-primary"
        >
          {project.title}
        </button>
        {project.priority === "high" && (
          <span className="rounded-full bg-destructive/12 px-2 py-0.5 text-[11px] text-destructive">
            {t("高优先级")}
          </span>
        )}
        <button
          type="button"
          onClick={() => void onRemove(project.id)}
          className="text-muted-foreground transition-colors hover:text-destructive"
          aria-label={t("删除")}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {t("负责人")}：{owner || t("未指定")}
        </span>
        {project.department && (
          <span>
            {t("部门")}：{project.department}
          </span>
        )}
        {project.due && (
          <span>
            {t("截止")}：{project.due}
          </span>
        )}
        {members.length > 0 && (
          <span>
            {t("参与")}：{members.join("、")}
          </span>
        )}
      </div>

      {project.detail && (
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
          {project.detail}
        </p>
      )}

      {(project.tags ?? []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(project.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
