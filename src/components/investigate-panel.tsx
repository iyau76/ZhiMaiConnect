import { Loader2, Search, Target } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { MarkdownView } from "@/components/markdown-view";
import { PlanBoard } from "@/components/plan-board";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { askStream } from "@/lib/ai-text";
import {
  facesDb,
  type EvidenceRecord,
  type PersonRecord,
  type RelationRecord,
} from "@/lib/face-db";
import { getLang, t } from "@/lib/i18n";
import type { ProviderPreset } from "@/lib/vision-providers";

type Focus = "plan" | "questions" | "interests" | "gaps";

const FOCUS: Array<{ id: Focus; zh: string; en: string }> = [
  { id: "plan", zh: "下一步找谁", en: "Who to interview next" },
  { id: "questions", zh: "问什么问题", en: "Questions to ask" },
  { id: "interests", zh: "利益牵扯", en: "Interest entanglements" },
  { id: "gaps", zh: "信息缺口", en: "Information gaps" },
];

const ASK: Record<Focus, { zh: string; en: string }> = {
  plan: {
    zh: "按优先级排出接下来应该接触/走访哪些人，每人说明为什么排这个顺序、想验证什么、建议的接触方式和注意事项。",
    en: "Rank who should be approached next, why in that order, what each contact should verify, suggested approach and cautions.",
  },
  questions: {
    zh: "为每个关键人物列出 4-6 个具体的询问问题，标出哪些是核对时间线的、哪些是交叉验证他人说法的，并提示可能的回避点。",
    en: "For each key person list 4-6 concrete interview questions, marking which check the timeline and which cross-verify others' statements, plus likely evasions.",
  },
  interests: {
    zh: "分析人物之间的利益牵扯：金钱往来、雇佣从属、亲属、竞争或冲突关系，指出谁有动机、谁可能串供、哪些关系存在矛盾说法。",
    en: "Analyse the interest entanglements: money flows, employment, kinship, rivalry or conflict; who has motive, who might collude, which ties have contradictory accounts.",
  },
  gaps: {
    zh: "指出档案里明显缺失或互相矛盾的信息，列出需要补充的材料和取证方向。",
    en: "Point out missing or contradictory information and list the material or evidence still needed.",
  },
};

export function InvestigatePanel({ preset }: { preset: ProviderPreset }) {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [focus, setFocus] = useState<Focus>("plan");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [p, r, e] = await Promise.all([
      facesDb.listPersons(),
      facesDb.listRelations(),
      facesDb.listEvidence(),
    ]);
    setPeople(p);
    setRelations(r);
    setEvidence(e);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? id;

  const run = async (extra?: string) => {
    if (!people.length && !evidence.length) {
      toast.error(t("库里还没有资料，先去「录入」写点情况"));
      return;
    }
    const zh = getLang() !== "en";
    const roster = people
      .map((person) => {
        const profile = person.profile ?? {};
        const bits = [
          profile.relation && `${zh ? "身份" : "role"}:${profile.relation}`,
          profile.age && `${zh ? "年龄" : "age"}:${profile.age}`,
          profile.address && `${zh ? "住址" : "address"}:${profile.address}`,
          profile.contact && `${zh ? "联系" : "contact"}:${profile.contact}`,
        ].filter(Boolean);
        return `- ${person.name}（${bits.join("，") || (zh ? "资料不全" : "sparse")}）${person.note || ""}`;
      })
      .join("\n");
    const links =
      relations.map((r) => `- ${nameOf(r.fromId)} —${r.label}→ ${nameOf(r.toId)}`).join("\n") ||
      (zh ? "暂无" : "none");
    const docs =
      evidence
        .slice(0, 20)
        .map((item) => `- [${item.kind}] ${item.title}：${item.text.slice(0, 400)}`)
        .join("\n") || (zh ? "暂无" : "none");

    const head = zh
      ? `你是资深办案分析助手。下面是当前案件资料。请用中文、分条给出可执行的建议，明确区分「材料里写明的事实」和「你的推测」，推测必须标注"推测"。不要编造资料里没有的人和事。`
      : `You are a senior investigation analyst. Below is the current case material. Answer in English with actionable, itemised advice, clearly separating stated facts from your inferences (label inferences). Never invent people or facts.`;

    const task = extra ?? (zh ? ASK[focus].zh : ASK[focus].en);

    setBusy(true);
    setAnswer("");
    try {
      await askStream(
        preset,
        `${head}\n\n【${zh ? "人物" : "People"}】\n${roster || (zh ? "暂无" : "none")}\n\n【${zh ? "关系" : "Relations"}】\n${links}\n\n【${zh ? "材料" : "Material"}】\n${docs}\n\n【${zh ? "任务" : "Task"}】\n${task}`,
        (chunk) => setAnswer((prev) => prev + chunk),
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-5">
      <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card/60 p-5">
        <header>
          <h2 className="flex items-baseline gap-2.5">
            <span className="font-display text-xl leading-none tracking-tight">
              {t("探案协助")}
            </span>
            <span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              Assist
            </span>
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "基于库里的人物、关系与材料，给出下一步走访建议、询问提纲和利益牵扯分析。结论仅供参考，需人工复核。",
            )}
          </p>
        </header>

        <div className="flex flex-wrap gap-1.5">
          {FOCUS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFocus(item.id)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                focus === item.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {getLang() === "en" ? item.en : item.zh}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {t("人物")} {people.length} · {t("关系")} {relations.length} · {t("材料")}{" "}
            {evidence.length}
          </span>
          <Button className="rounded-full px-5" onClick={() => void run()} disabled={busy}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Target className="size-3.5" aria-hidden="true" />
            )}
            {t("生成建议")}
          </Button>
        </div>

        <div className="space-y-2">
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={2}
            className="text-sm"
            placeholder={t("也可以直接问，例：李强和张伟的说法哪里对不上？")}
          />
          <Button
            variant="outline"
            className="rounded-full px-4"
            disabled={busy || !question.trim()}
            onClick={() => void run(question.trim())}
          >
            <Search className="size-3.5" aria-hidden="true" />
            {t("问这个")}
          </Button>
        </div>

        {answer && (
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <MarkdownView text={answer} />
          </div>
        )}
      </section>
      <PlanBoard preset={preset} />
    </div>
  );
}
