import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import {
  addTemplateField,
  loadTemplate,
  removeTemplateField,
  type CustomField,
} from "@/lib/card-template";
import { PhotoNotes } from "@/components/photo-notes";
import { SourceBadge } from "@/components/source-badge";
import {
  facesDb,
  personRecordRevision,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type PersonProfile,
  type PersonRecord,
  type PhotoNote,
} from "@/lib/face-db";
import { normalizeCloseness } from "@/lib/person-profile";
import { askModel } from "@/lib/vision-client";
import type { ProviderPreset } from "@/lib/vision-providers";
import { t } from "@/lib/i18n";
import { PRESET_TAGS } from "@/lib/circle-tags";

interface Props {
  person: PersonRecord | null;
  preset: ProviderPreset;
  collections: CollectionRecord[];
  collectionMemberships: CollectionMembershipRecord[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const EXTRACT_PROMPT = `你是个人人脉助手。用户会给你一段关于身边某个人的自由描述，请整理成 JSON。
只输出 JSON，不要任何解释、不要代码块标记。字段如下（没有信息就省略该字段，不要编造）：
{"age":"年龄","gender":"性别","birthday":"生日 MM-DD 或 YYYY-MM-DD","closeness":3,"relation":"和我的关系，如大学同学","likes":["喜好1","喜好2"],"dislikes":["忌口或不喜欢"],"gifts":["以前送过的礼物"],"metAt":"在哪认识的","title":"职业/职位","org":"单位/学校","tags":["简短标签"],"contact":"联系方式","address":"常住地","note":"其它补充说明，一句话","extra":{"自定义字段名":"值"}}`;

function parseJson(text: string) {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(t("AI 没有返回可解析的资料"));
  return JSON.parse(cleaned.slice(start, end + 1)) as PersonProfile & { note?: string };
}

const toList = (value: unknown) =>
  Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;

export function PersonProfileDialog({
  person,
  preset,
  collections,
  collectionMemberships,
  onClose,
  onSaved,
}: Props) {
  const [raw, setRaw] = useState("");
  const [profile, setProfile] = useState<PersonProfile>({});
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<CustomField[]>([]);
  const [newField, setNewField] = useState("");
  const [photos, setPhotos] = useState<PhotoNote[]>([]);
  const [selectedCircleIds, setSelectedCircleIds] = useState<string[]>([]);
  const [newCircleName, setNewCircleName] = useState("");
  const [pendingCircleNames, setPendingCircleNames] = useState<string[]>([]);

  const relationshipCircles = useMemo(
    () => collections.filter((collection) => collection.kind === "relationship_circle"),
    [collections],
  );

  useEffect(() => {
    if (!person) return;
    setRaw(person.rawProfileText ?? "");
    setProfile(person.profile ?? {});
    setNote(person.note ?? "");
    setName(person.name);
    setPhotos(person.photos ?? []);
    setTemplate(loadTemplate());
    const circleIds = new Set(relationshipCircles.map((collection) => collection.id));
    setSelectedCircleIds(
      collectionMemberships
        .filter(
          (membership) =>
            membership.personId === person.id &&
            membership.source !== "computed" &&
            circleIds.has(membership.collectionId),
        )
        .map((membership) => membership.collectionId),
    );
    setNewCircleName("");
    setPendingCircleNames([]);
  }, [person, relationshipCircles, collectionMemberships]);

  const organize = async () => {
    const text = raw.trim();
    if (!text) {
      toast.error(t("先写一段关于 TA 的描述"));
      return;
    }
    setBusy(true);
    let buffer = "";
    try {
      await askModel(
        preset,
        `${EXTRACT_PROMPT}\n\n姓名：${name}\n描述：${text}`,
        null,
        [],
        (chunk) => {
          buffer += chunk;
        },
        new AbortController().signal,
      );
      const parsed = parseJson(buffer);
      const str = (value: unknown) => (value ? String(value) : undefined);
      setProfile((prev) => ({
        ...prev,
        age: str(parsed.age) ?? prev.age,
        gender: str(parsed.gender) ?? prev.gender,
        relation: str(parsed.relation) ?? prev.relation,
        birthday: str(parsed.birthday) ?? prev.birthday,
        closeness: normalizeCloseness(parsed.closeness) ?? prev.closeness,
        likes: toList(parsed.likes) ?? prev.likes,
        dislikes: toList(parsed.dislikes) ?? prev.dislikes,
        gifts: toList(parsed.gifts) ?? prev.gifts,
        metAt: str(parsed.metAt) ?? prev.metAt,
        title: str(parsed.title) ?? prev.title,
        org: str(parsed.org) ?? prev.org,
        address: str(parsed.address) ?? prev.address,
        tags: toList(parsed.tags) ?? prev.tags,
        contact: str(parsed.contact) ?? prev.contact,
        extra:
          parsed.extra && typeof parsed.extra === "object"
            ? {
                ...(prev.extra ?? {}),
                ...Object.fromEntries(
                  Object.entries(parsed.extra).map(([key, value]) => [key, String(value)]),
                ),
              }
            : prev.extra,
      }));
      if (parsed.note) setNote(String(parsed.note));
      toast.success(t("AI 已整理好，可再手动微调"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!person) return;
    setSaving(true);
    try {
      let base = person;
      while (true) {
        const now = Date.now();
        const newCircles = pendingCircleNames.map((circleName) => ({
          id: `collection:${crypto.randomUUID()}`,
          name: circleName,
          kind: "relationship_circle" as const,
          createdAt: now,
          updatedAt: now,
        }));
        const result = await facesDb.compareAndSwapPerson(
          {
            ...base,
            name: name.trim() || base.name,
            note,
            profile: { ...profile, closeness: normalizeCloseness(profile.closeness) },
            rawProfileText: raw,
            photos,
            updatedAt: now,
          },
          personRecordRevision(base),
          {
            selectedCircleIds: [...selectedCircleIds, ...newCircles.map((circle) => circle.id)],
            newCircles,
          },
        );
        if (result.status === "saved") break;
        if (result.status === "missing") {
          toast.error(t("这份人物档案已被删除，无法保存"));
          onClose();
          return;
        }
        if (!window.confirm(t("这份档案已在其他窗口更新。仍要用当前编辑内容覆盖吗？"))) {
          return;
        }
        base = result.current;
      }
      await onSaved();
      toast.success(t("资料已保存"));
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 标签只展示已经由用户确认的值；AI 整理结果仍要在保存前签字。 */
  const manualTags = (profile.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const allTags = [...new Set(manualTags)];

  /** 点一下加/去标签。 */
  const toggleTag = (label: string) => {
    setProfile((prev) => {
      const list = (prev.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
      const on = list.includes(label);
      return { ...prev, tags: on ? list.filter((tag) => tag !== label) : [...list, label] };
    });
  };

  const toggleCircle = (collectionId: string) => {
    setSelectedCircleIds((current) =>
      current.includes(collectionId)
        ? current.filter((id) => id !== collectionId)
        : [...current, collectionId],
    );
  };

  const addCircle = () => {
    const name = newCircleName.trim();
    if (!name) return;
    const existing = relationshipCircles.find(
      (collection) =>
        collection.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
    );
    if (existing) {
      setSelectedCircleIds((current) =>
        current.includes(existing.id) ? current : [...current, existing.id],
      );
    } else if (
      !pendingCircleNames.some(
        (item) => item.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
      )
    ) {
      setPendingCircleNames((current) => [...current, name]);
    }
    setNewCircleName("");
  };

  const field = (key: keyof PersonProfile, label: string) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={(profile[key] as string) ?? ""}
        onChange={(event) => setProfile((prev) => ({ ...prev, [key]: event.target.value }))}
        className="h-8 text-xs"
      />
    </div>
  );

  const listField = (key: "projects" | "tags" | "likes" | "dislikes" | "gifts", label: string) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}（逗号分隔）</Label>
      <Input
        value={(profile[key] ?? []).join("、")}
        onChange={(event) =>
          setProfile((prev) => ({
            ...prev,
            [key]: event.target.value
              .split(/[、,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
          }))
        }
        className="h-8 text-xs"
      />
    </div>
  );

  const extraField = (key: string, removable: boolean) => (
    <div key={key} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="truncate text-xs text-muted-foreground">{key}</Label>
        {removable && (
          <button
            type="button"
            title={t("从模板删除该栏")}
            className="text-muted-foreground transition-colors hover:text-destructive"
            onClick={() => setTemplate(removeTemplateField(key))}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
      <Input
        value={profile.extra?.[key] ?? ""}
        onChange={(event) =>
          setProfile((prev) => ({
            ...prev,
            extra: { ...(prev.extra ?? {}), [key]: event.target.value },
          }))
        }
        className="h-8 text-xs"
      />
    </div>
  );

  return (
    <Dialog open={!!person} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("编辑人员资料")}</DialogTitle>
          <DialogDescription>
            {t(
              "写一段自然语言描述，点「AI 自动整理」，会自动拆成生日、关系、喜好、送礼记录等字段；圈层也可以在人物卡中手动选择或新建。",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("姓名")}</Label>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("随便写一段（AI 会整理）")}</Label>
            <Textarea
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={4}
              placeholder={t(
                "例如：张伟，我大学室友，3 月 12 日生日，爱打篮球、怕辣，现在在杭州做产品经理，去年生日送过他一副耳机。",
              )}
              className="text-xs"
            />
            <Button size="sm" variant="outline" onClick={() => void organize()} disabled={busy}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3.5" aria-hidden="true" />
              )}
              {t("AI 自动整理")}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field("birthday", t("生日（MM-DD）"))}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("亲密度 1-5")}</Label>
              <Input
                type="number"
                min={1}
                max={5}
                value={profile.closeness ?? ""}
                onChange={(event) =>
                  setProfile((prev) => ({
                    ...prev,
                    closeness: event.target.value
                      ? normalizeCloseness(event.target.value)
                      : undefined,
                  }))
                }
                className="h-8 text-xs"
              />
            </div>
            {field("relation", t("和我的关系"))}
            {field("metAt", t("在哪认识的"))}
            {field("contact", t("联系方式"))}
            {field("title", t("职业 / 职位"))}
            {field("org", t("单位 / 学校"))}
            {field("address", t("常住地"))}
            {field("age", t("年龄"))}
            {field("gender", t("性别"))}
            {listField("likes", t("喜好"))}
            {listField("dislikes", t("忌口 / 不喜欢"))}
            {listField("gifts", t("送礼记录"))}
          </div>

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">{t("圈层")}</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("人物可以属于多个圈层；保存后会立即用于关系网的圈层布局。")}
                </p>
              </div>
              {selectedCircleIds.length === 0 && pendingCircleNames.length === 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t("未分圈层")}
                </span>
              )}
            </div>
            {relationshipCircles.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {relationshipCircles.map((circle) => {
                  const selected = selectedCircleIds.includes(circle.id);
                  return (
                    <button
                      key={circle.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleCircle(circle.id)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      {circle.name}
                    </button>
                  );
                })}
              </div>
            )}
            {pendingCircleNames.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pendingCircleNames.map((circleName) => (
                  <button
                    key={circleName}
                    type="button"
                    title={t("取消新建圈层")}
                    onClick={() =>
                      setPendingCircleNames((current) =>
                        current.filter((item) => item !== circleName),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-[11px] text-foreground"
                  >
                    {circleName}
                    <X className="size-3" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={newCircleName}
                onChange={(event) => setNewCircleName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addCircle();
                }}
                placeholder={t("新圈层名称，如：同学、家人、项目伙伴")}
                className="h-8 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!newCircleName.trim()}
                onClick={addCircle}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("新建并加入")}
              </Button>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">{t("身份与昵称历史")}</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("保留平台账号、曾用昵称和生效时间，改名不会覆盖旧身份。")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() =>
                  setProfile((prev) => ({
                    ...prev,
                    identities: [
                      ...(prev.identities ?? []),
                      { platform: "", alias: "", source: { kind: "manual", at: Date.now() } },
                    ],
                  }))
                }
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("添加身份")}
              </Button>
            </div>
            {(profile.identities ?? []).map((identity, index) => (
              <div
                key={`${identity.platform}-${identity.alias}-${index}`}
                className="grid gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-2"
              >
                {(
                  [
                    ["platform", t("平台 / 场景")],
                    ["account", t("账号（可选）")],
                    ["alias", t("昵称 / 身份名")],
                    ["validFrom", t("生效时间")],
                    ["validTo", t("失效时间（可选）")],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="space-y-1 text-[11px] text-muted-foreground">
                    <span>{label}</span>
                    <Input
                      value={identity[key] ?? ""}
                      onChange={(event) =>
                        setProfile((prev) => ({
                          ...prev,
                          identities: (prev.identities ?? []).map((item, itemIndex) =>
                            itemIndex === index ? { ...item, [key]: event.target.value } : item,
                          ),
                        }))
                      }
                      className="h-8 text-xs"
                    />
                  </label>
                ))}
                <div className="flex items-center justify-between gap-2 sm:col-span-2">
                  <SourceBadge source={identity.source} />
                  <button
                    type="button"
                    className="text-[11px] text-destructive hover:underline"
                    onClick={() =>
                      setProfile((prev) => ({
                        ...prev,
                        identities: (prev.identities ?? []).filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      }))
                    }
                  >
                    {t("删除这条身份")}
                  </button>
                </div>
              </div>
            ))}
            {(profile.identities ?? []).length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t("尚未记录历史身份")}</p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-muted-foreground">{t("标签分组")}</Label>
              {allTags.length === 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t("未分组")}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("这里只使用你确认过的标签；AI 整理出的标签会在保存前供你检查。")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_TAGS.map((raw) => {
                const label = t(raw);
                const on = manualTags.includes(label);
                return (
                  <button
                    key={raw}
                    type="button"
                    onClick={() => toggleTag(label)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      on
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/50"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {listField("tags", t("其它标签"))}
          </div>

          <div className="space-y-2 rounded-lg border border-border p-2.5">
            <p className="text-xs text-muted-foreground">{t("自定义栏位（对所有人物卡生效）")}</p>
            <div className="grid grid-cols-2 gap-3">
              {template.map((item) => extraField(item.name, true))}
              {Object.keys(profile.extra ?? {})
                .filter((key) => !template.some((item) => item.name === key))
                .map((key) => extraField(key, false))}
            </div>
            <div className="flex gap-2">
              <Input
                value={newField}
                onChange={(event) => setNewField(event.target.value)}
                placeholder={t("新栏位名称，如分管条线")}
                className="h-8 text-xs"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (!newField.trim()) return;
                  setTemplate(addTemplateField(newField));
                  setNewField("");
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  if (!newField.trim()) {
                    toast.error(t("先填栏位名称"));
                    return;
                  }
                  setTemplate(addTemplateField(newField));
                  setNewField("");
                }}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("添加栏位")}
              </Button>
            </div>
          </div>

          <PhotoNotes photos={photos} onChange={setPhotos} />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("备注")}</Label>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className="text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            {t("保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
