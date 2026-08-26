/** 个人版：提醒 —— 生日、节日、待办，以及「这事该拜托谁」 */

import { Cake, Check, Gift, Loader2, PartyPopper, Plus, Sparkles, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MarkdownView } from "@/components/markdown-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { askText } from "@/lib/ai-text";
import { facesDb, type PersonRecord, type ReminderRecord } from "@/lib/face-db";
import { blessingPrompt, upcoming, todayStr, type UpcomingItem } from "@/lib/personal";
import type { ProviderPreset } from "@/lib/vision-providers";

export function RemindersPanel({ preset }: { preset: ProviderPreset }) {
  const [persons, setPersons] = useState<PersonRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ key: string; text: string } | null>(null);
  const [ask, setAsk] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState("");

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([facesDb.listPersons(), facesDb.listReminders()]);
    setPersons(p);
    setReminders(r);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => upcoming(persons, 60), [persons]);

  const suggest = async (item: UpcomingItem) => {
    setBusyKey(item.key);
    setAnswer(null);
    try {
      const text = await askText(preset, blessingPrompt(item));
      setAnswer({ key: item.key, text });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 请求失败");
    } finally {
      setBusyKey(null);
    }
  };

  const addFrom = async (item: UpcomingItem) => {
    const record: ReminderRecord = {
      id: crypto.randomUUID(),
      title: item.kind === "birthday" ? `给 ${item.person?.name} 送生日祝福` : `${item.title}问候`,
      due: undefined,
      personIds: item.person ? [item.person.id] : [],
      kind: item.kind,
      done: false,
      createdAt: Date.now(),
    };
    await facesDb.putReminder(record);
    await load();
    toast.success("已加入待办");
  };

  const addManual = async () => {
    if (!title.trim()) return;
    await facesDb.putReminder({
      id: crypto.randomUUID(),
      title: title.trim(),
      due: due || undefined,
      kind: "custom",
      done: false,
      createdAt: Date.now(),
    });
    setTitle("");
    setDue("");
    await load();
  };

  const toggle = async (record: ReminderRecord) => {
    await facesDb.putReminder({ ...record, done: !record.done });
    await load();
  };

  const remove = async (id: string) => {
    await facesDb.deleteReminder(id);
    await load();
  };

  const askWho = async () => {
    if (!ask.trim()) return;
    setAskBusy(true);
    setAskAnswer("");
    try {
      const roster = persons
        .slice(0, 80)
        .map((person) => {
          const p = person.profile ?? {};
          return `- ${person.name}｜${p.circle ?? "未分组"}｜亲密度 ${p.closeness ?? "?"}/5｜${p.title ?? ""} ${p.org ?? ""}｜擅长/喜好：${(p.likes ?? []).join("、") || "未知"}｜备注：${person.note || "无"}`;
        })
        .join("\n");
      const text = await askText(
        preset,
        `这是我的人脉库：\n${roster || "（还没有人物）"}\n\n我遇到的事情：${ask.trim()}\n\n请从上面的人里挑 1-3 位最合适帮忙的人，说明理由（关系、亲密度、能力匹配），并给出可以直接发出去的开场消息。如果库里没有合适的人，直说并给出替代办法。中文，简短分点。`,
      );
      setAskAnswer(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 请求失败");
    } finally {
      setAskBusy(false);
    }
  };

  const open = reminders.filter((item) => !item.done);
  const done = reminders.filter((item) => item.done);

  return (
    <div className="min-w-0 space-y-5">
      {/* 即将到来 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Cake className="size-4 text-primary" aria-hidden="true" />
          最近 60 天
        </h2>
        {items.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            还没有生日信息。到「人物关系」给人物填上生日，这里就会自动提醒。
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <li key={item.key} className="rounded-xl border border-border bg-background/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm">
                    {item.kind === "birthday" ? (
                      <Cake className="size-3.5 text-primary" aria-hidden="true" />
                    ) : (
                      <PartyPopper className="size-3.5 text-primary" aria-hidden="true" />
                    )}
                    {item.title}
                    <span className="text-[11px] text-muted-foreground">
                      {item.md} · {item.days === 0 ? "就是今天" : `还有 ${item.days} 天`}
                    </span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => void suggest(item)} disabled={busyKey === item.key}>
                      {busyKey === item.key ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="size-3.5" aria-hidden="true" />
                      )}
                      祝福 / 礼物
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void addFrom(item)}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      待办
                    </Button>
                  </span>
                </div>
                {answer?.key === item.key && (
                  <div className="mt-3 rounded-lg border border-border bg-card p-3">
                    <MarkdownView text={answer.text} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 待办 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Gift className="size-4 text-primary" aria-hidden="true" />
          我的待办
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：周末给外婆打个电话"
            className="min-w-0 flex-1"
          />
          <Input
            type="date"
            value={due}
            min={todayStr()}
            onChange={(event) => setDue(event.target.value)}
            className="w-40"
          />
          <Button onClick={() => void addManual()} disabled={!title.trim()}>
            <Plus className="size-4" aria-hidden="true" />
            添加
          </Button>
        </div>

        <ul className="mt-4 space-y-1.5">
          {[...open, ...done].map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2"
            >
              <button
                type="button"
                onClick={() => void toggle(record)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${record.done ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                >
                  {record.done && <Check className="size-3" aria-hidden="true" />}
                </span>
                <span className={`truncate text-sm ${record.done ? "text-muted-foreground line-through" : ""}`}>
                  {record.title}
                </span>
                {record.due && <span className="text-[11px] text-muted-foreground">{record.due}</span>}
              </button>
              <button
                type="button"
                onClick={() => void remove(record.id)}
                aria-label="删除"
                className="text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
          {reminders.length === 0 && (
            <li className="text-xs text-muted-foreground">还没有待办，可以从上面的生日 / 节日一键加入。</li>
          )}
        </ul>
      </section>

      {/* 这事拜托谁 */}
      <section className="rounded-2xl border border-border bg-card/40 p-4 md:p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4 text-primary" aria-hidden="true" />
          这事该拜托谁
        </h2>
        <Textarea
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
          rows={3}
          placeholder="例如：我想找人帮忙看一下租房合同，谁比较合适？"
          className="mt-3"
        />
        <div className="mt-2 flex justify-end">
          <Button onClick={() => void askWho()} disabled={askBusy || !ask.trim()}>
            {askBusy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            问问 AI
          </Button>
        </div>
        {askAnswer && (
          <div className="mt-3 rounded-lg border border-border bg-background/60 p-3">
            <MarkdownView text={askAnswer} />
          </div>
        )}
      </section>
    </div>
  );
}
