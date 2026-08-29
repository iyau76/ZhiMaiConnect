import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_PROMPT_MAX_CHARACTERS } from "./ai-request-contract";
import { MemoryAgentRunRecorder } from "./agent-run-log";
import { compileIntakePlan, runIntakeAgent, serializeIntakeHistory } from "./intake-agent";

const { askModelMock } = vi.hoisted(() => ({ askModelMock: vi.fn() }));
vi.mock("./vision-client", () => ({ askModel: askModelMock }));

const preset = {
  id: "test",
  name: "测试模型",
  kind: "lovable" as const,
  baseUrl: "",
  model: "test-model",
  apiKey: "",
};

describe("intake agent", () => {
  beforeEach(() => askModelMock.mockReset());

  it("budgets structured rules, source material, prior draft and tools as separate sections", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      expect(prompt.length).toBeLessThanOrEqual(AGENT_PROMPT_MAX_CHARACTERS);
      expect(prompt).toContain("本次材料");
      expect(prompt).toContain("stage_person_update");
      expect(prompt).not.toContain("propose_archive_mutations");
      (args[4] as (chunk: string) => void)(
        JSON.stringify({ type: "final", draft: { summary: "预算内完成" } }),
      );
    });

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: {
        instructions: `固定抽取规则：${"规则".repeat(1_500)}`,
        knownContext: Array.from({ length: 70 }, (_, index) => `人物${index}`).join("、"),
        previousDraft: {
          people: Array.from({ length: 70 }, (_, index) => ({
            name: `人物${index}`,
            note: "旧草稿".repeat(100),
          })),
        },
        sourceMaterial: "本轮复杂关系材料。".repeat(2_000),
      },
      persons: [],
      relations: [],
      events: [],
      includeArchive: true,
    });

    expect(result.summary).toBe("预算内完成");
  });

  it("searches an event and stages an update without writing it", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      expect(String(args[1])).toContain('"nextAction":"declare_plan"');
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          tasks: [
            {
              id: "event-dinner",
              domain: "event",
              intent: "update",
              target: { title: "团队聚餐" },
              changes: { date: "2026-09-02" },
            },
          ],
        }),
      );
    });
    const original = {
      id: "event-1",
      title: "团队聚餐",
      date: "2026-09-01",
      precision: "day" as const,
      createdAt: 1,
    };

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "把日期改到 9 月 2 日",
      persons: [],
      events: [original],
      includeArchive: true,
      sourceMaterial: "团队聚餐改到 9 月 2 日",
    });

    expect(result.events?.[0]).toMatchObject({
      targetEventId: "event-1",
      title: "团队聚餐",
      date: "2026-09-02",
    });
    expect(original.date).toBe("2026-09-01");
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("treats relations as first-class archive records and stages an update", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          tasks: [
            {
              id: "relation-tang-zhou",
              domain: "relation",
              intent: "update",
              target: { from: "唐悦", to: "周宁", label: "同事" },
              changes: {
                label: "前同事",
                basis: "原文：唐悦和周宁现在是前同事",
              },
            },
          ],
        }),
      );
    });
    const persons = [
      { id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const relations = [
      {
        id: "r1",
        fromId: "p1",
        toId: "p2",
        label: "同事",
        basis: "原文：两人同事",
        createdAt: 1,
      },
    ];
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "他们现在是前同事",
      persons,
      events: [],
      relations,
      includeArchive: true,
      sourceMaterial: "唐悦和周宁现在是前同事",
    });
    expect(result.relations).toEqual([
      expect.objectContaining({ targetRelationId: "r1", label: "前同事" }),
    ]);
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("rejects the real DeepSeek plan with an undeclared relation endpoint before accepting any task", async () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "missing-endpoint-repair" });
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain('"persons":[{"id":"jia-mu","name":"贾母"');
        expect(prompt).toContain('{"id":"jia-zheng","name":"贾政"');
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "plan",
            summary: "抽取贾敏与林黛玉的关系",
            tasks: [
              {
                id: "person-1",
                domain: "person",
                intent: "create",
                target: { name: "林黛玉" },
                changes: { name: "林黛玉" },
              },
              {
                id: "relation-1",
                domain: "relation",
                intent: "create",
                target: { from: "贾母", to: "贾敏", label: "母女" },
                changes: {
                  from: "贾母",
                  to: "贾敏",
                  label: "女儿",
                  basis: "原文：贾敏是贾母的女儿",
                },
              },
              {
                id: "relation-2",
                domain: "relation",
                intent: "create",
                target: { from: "贾敏", to: "林黛玉", label: "母女" },
                changes: {
                  from: "贾敏",
                  to: "林黛玉",
                  label: "女儿",
                  basis: "原文：林黛玉是贾敏的女儿",
                },
              },
            ],
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("人物端点");
        expect(prompt).toContain("贾敏");
        expect(prompt).toContain('"phase":"planning","tasks":[]');
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "plan",
            summary: "补齐两名新人物和两条明确关系",
            tasks: [
              {
                id: "person-jiamin",
                domain: "person",
                intent: "create",
                target: { name: "贾敏" },
                changes: { name: "贾敏" },
              },
              {
                id: "person-daiyu",
                domain: "person",
                intent: "create",
                target: { name: "林黛玉" },
                changes: { name: "林黛玉" },
              },
              {
                id: "relation-jiamin",
                domain: "relation",
                intent: "create",
                target: { from: "贾母", to: "贾敏", label: "母女" },
                changes: { label: "女儿", basis: "原文：贾敏是贾母的女儿" },
              },
              {
                id: "relation-daiyu",
                domain: "relation",
                intent: "create",
                target: { from: "贾敏", to: "林黛玉", label: "母女" },
                changes: { label: "女儿", basis: "原文：林黛玉是贾敏的女儿" },
              },
            ],
          }),
        );
      });
    const persons = [
      { id: "jia-mu", name: "贾母", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "jia-zheng", name: "贾政", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "贾敏是贾母的女儿。林黛玉是贾敏的女儿。",
      sourceMaterial: "贾敏是贾母的女儿。林黛玉是贾敏的女儿。",
      persons,
      relations: [],
      events: [],
      includeArchive: true,
      recorder,
    });

    expect(result.people?.map((person) => person.name)).toEqual(["贾敏", "林黛玉"]);
    expect(result.relations).toEqual([
      expect.objectContaining({ from: "贾母", to: "贾敏", toDraftId: "plan:person-jiamin" }),
      expect.objectContaining({
        from: "贾敏",
        to: "林黛玉",
        fromDraftId: "plan:person-jiamin",
        toDraftId: "plan:person-daiyu",
      }),
    ]);
    expect(
      recorder
        .events()
        .find(
          (event) =>
            event.kind === "validation" &&
            (event.payload as { action?: string } | undefined)?.action === "repair_requested",
        ),
    ).toMatchObject({ status: "failed", round: 1 });
    expect(askModelMock).toHaveBeenCalledTimes(2);
  });

  it("compiles the real DeepSeek create-event output into the unique existing event update", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      expect(prompt).toContain(
        '"events":[{"id":"event-1","title":"团队聚餐","date":"2026-09-01"}]',
      );
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          summary: "更新人物、关系和团队聚餐",
          tasks: [
            {
              id: "person-1",
              domain: "person",
              intent: "update",
              target: { name: "唐悦" },
              changes: { title: "品牌总监" },
            },
            {
              id: "relation-1",
              domain: "relation",
              intent: "update",
              target: { from: "唐悦", to: "周宁", label: "同事" },
              changes: { label: "前同事", basis: "原文：唐悦和周宁现在是前同事" },
            },
            {
              id: "event-1",
              domain: "event",
              intent: "create",
              target: { title: "团队聚餐" },
              changes: { date: "2026-09-02", people: ["唐悦", "周宁"] },
            },
          ],
        }),
      );
    });
    const persons = [
      { id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "唐悦升为品牌总监；唐悦和周宁现在是前同事；团队聚餐改到2026-09-02",
      sourceMaterial: "唐悦升为品牌总监；唐悦和周宁现在是前同事；团队聚餐改到2026-09-02",
      persons,
      relations: [
        {
          id: "r1",
          fromId: "p1",
          toId: "p2",
          label: "同事",
          basis: "原文：唐悦和周宁是同事",
          createdAt: 1,
        },
      ],
      events: [
        {
          id: "event-1",
          title: "团队聚餐",
          date: "2026-09-01",
          precision: "day",
          createdAt: 1,
        },
      ],
      includeArchive: true,
    });

    expect(result.people?.[0]).toMatchObject({ targetPersonId: "p1", title: "品牌总监" });
    expect(result.relations?.[0]).toMatchObject({ targetRelationId: "r1", label: "前同事" });
    expect(result.events?.[0]).toMatchObject({
      targetEventId: "event-1",
      title: "团队聚餐",
      date: "2026-09-02",
    });
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("executes a bounded batch of independent read tools in one model round", async () => {
    askModelMock
      .mockImplementationOnce(async (...args: unknown[]) => {
        (args[4] as (chunk: string) => void)(
          JSON.stringify({
            type: "tools",
            calls: [
              { tool: "get_profile", args: { personId: "p1" } },
              { tool: "get_relation", args: { relationId: "r1" } },
            ],
          }),
        );
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        expect(prompt).toContain("甲");
        expect(prompt).toContain("同事");
        (args[4] as (chunk: string) => void)(
          JSON.stringify({ type: "final", draft: { summary: "核对完成" } }),
        );
      });
    const persons = [
      { id: "p1", name: "甲", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "乙", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "核对甲乙关系",
      persons,
      events: [],
      relations: [{ id: "r1", fromId: "p1", toId: "p2", label: "同事", createdAt: 1 }],
      includeArchive: true,
    });
    expect(result.summary).toBe("核对完成");
    expect(askModelMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a schema-valid relation visible when its evidence is missing instead of entering a repair loop", async () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "repair-ledger" });
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "final",
          draft: { relations: [{ from: "甲", to: "乙", label: "同事" }] },
        }),
      );
    });
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "甲和乙是同事",
      persons: [],
      events: [],
      includeArchive: false,
      recorder,
    });
    expect(result.relations?.[0]).toMatchObject({
      from: "甲",
      to: "乙",
      _relationChecked: false,
      _relationReason: expect.stringContaining("AI 未提供可回查的原文依据"),
    });
    expect(askModelMock).toHaveBeenCalledTimes(1);
    expect(
      recorder.events().some((event) => event.kind === "validation" && event.status === "failed"),
    ).toBe(false);
  });

  it("keeps a model-derived relationship visible with a soft audit warning", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "final",
          draft: {
            relations: [
              {
                from: "贾母",
                to: "贾宝玉",
                label: "祖孙",
                basis: "推断依据：贾母是贾政之母，贾政是贾宝玉之父",
                confidence: 0.7,
              },
            ],
          },
        }),
      );
    });
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      persons: [],
      events: [],
      includeArchive: false,
    });
    expect(result.relations).toHaveLength(1);
    expect(result.relations?.[0]).toMatchObject({
      label: "祖孙",
      _relationChecked: false,
      _relationReason: expect.stringContaining("AI 推导关系"),
    });
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("locally stages mixed updates and a new event from one typed plan", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      expect(prompt).toContain('"phase":"planning"');
      expect(prompt).toContain("稳定 ID 只能复制上方结构化索引，不得编造");
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          summary: "三项变更已暂存",
          tasks: [
            {
              id: "person-tang",
              domain: "person",
              intent: "update",
              target: { name: "唐悦" },
              changes: { title: "品牌总监" },
            },
            {
              id: "relation-tang-zhou",
              domain: "relation",
              intent: "update",
              target: { from: "唐悦", to: "周宁", label: "同事" },
              changes: { label: "前同事", basis: "原文：她和周宁关系改为前同事" },
            },
            {
              id: "event-meeting",
              domain: "event",
              intent: "create",
              target: { title: "会议" },
              changes: { date: "2026-09-02", people: ["唐悦", "周宁"] },
            },
          ],
        }),
      );
    });
    const persons = [
      {
        id: "p1",
        name: "唐悦",
        note: "",
        profile: { title: "品牌经理" },
        descriptors: [],
        thumb: "",
        createdAt: 1,
      },
      { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      sourceMaterial: "唐悦职务改为品牌总监；她和周宁关系改为前同事；新增9月2日会议",
      persons,
      events: [],
      relations: [
        {
          id: "r1",
          fromId: "p1",
          toId: "p2",
          label: "同事",
          basis: "原文：同事",
          createdAt: 1,
        },
      ],
      includeArchive: true,
      budget: {
        maxRounds: 12,
        maxToolCalls: 20,
        maxInputTokens: 40_000,
        maxOutputTokens: 8_000,
        maxWallTimeMs: 120_000,
      },
    });
    expect(result.people?.[0]).toMatchObject({ targetPersonId: "p1", title: "品牌总监" });
    expect(result.relations?.[0]).toMatchObject({ targetRelationId: "r1", label: "前同事" });
    expect(result.events?.[0]).toMatchObject({ title: "会议", date: "2026-09-02" });
    expect(result.events?.[0].targetEventId).toBeUndefined();
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing relation while continuously staging a new relation", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          summary: "新增合作关系",
          tasks: [
            {
              id: "new-relation",
              domain: "relation",
              intent: "create",
              target: { from: "唐悦", to: "林岚" },
              changes: { label: "合作伙伴", basis: "原文：唐悦和林岚开始合作" },
            },
          ],
        }),
      );
    });
    const persons = [
      { id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 1 },
      { id: "p3", name: "林岚", note: "", descriptors: [], thumb: "", createdAt: 1 },
    ];
    const existing = {
      id: "r1",
      fromId: "p1",
      toId: "p2",
      label: "前同事",
      basis: "原文：前同事",
      createdAt: 1,
    };
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      sourceMaterial: "另外，唐悦和林岚开始合作，是合作伙伴",
      persons,
      events: [],
      relations: [existing],
      includeArchive: true,
    });
    expect(result.relations).toEqual([
      expect.objectContaining({ from: "唐悦", to: "林岚", label: "合作伙伴" }),
    ]);
    expect(result.relations?.[0].targetRelationId).toBeUndefined();
    expect(existing.label).toBe("前同事");
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("stages a new person and a relation to that draft in the same typed plan", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          tasks: [
            {
              id: "new-person",
              domain: "person",
              intent: "create",
              target: { name: "林岚" },
              changes: { title: "设计师" },
            },
            {
              id: "new-relation",
              domain: "relation",
              intent: "create",
              target: { from: "唐悦", to: "林岚" },
              changes: { label: "合作伙伴", basis: "原文：她和唐悦是合作伙伴" },
            },
          ],
        }),
      );
    });
    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      sourceMaterial: "新认识的林岚是设计师，她和唐悦是合作伙伴",
      persons: [{ id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 }],
      events: [],
      relations: [],
      includeArchive: true,
    });
    expect(result.people?.[0]).toMatchObject({ name: "林岚", title: "设计师" });
    expect(result.relations?.[0]).toMatchObject({ to: "林岚", toDraftId: "plan:new-person" });
  });

  it("keeps a reminder in the same typed plan and binds it to the new person", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          tasks: [
            {
              id: "new-person",
              domain: "person",
              intent: "create",
              target: { name: "唐悦" },
              changes: { relation: "大学摄影社搭档" },
            },
            {
              id: "send-list",
              domain: "reminder",
              intent: "create",
              target: { title: "给唐悦发送拍摄清单" },
              changes: { due: "2026-08-28", people: ["唐悦"], kind: "custom" },
            },
          ],
        }),
      );
    });

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      sourceMaterial: "唐悦是摄影社搭档，提醒我8月28日给她发送拍摄清单",
      persons: [],
      events: [],
      relations: [],
      includeArchive: true,
    });

    expect(result.reminders?.[0]).toMatchObject({
      title: "给唐悦发送拍摄清单",
      due: "2026-08-28",
      people: ["唐悦"],
      peopleDraftIds: ["plan:new-person"],
    });
  });

  it("keeps explicit facts and evidence inside the same typed-plan contract", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          type: "plan",
          tasks: [
            {
              id: "new-person",
              domain: "person",
              intent: "create",
              target: { name: "贾母" },
              changes: { note: "荣国府老太太" },
            },
            {
              id: "fact-1",
              domain: "fact",
              intent: "create",
              target: { person: "贾母", personId: "plan:new-person", key: "身份" },
              changes: { value: "荣国府老太太", basis: "原文：贾母是荣国府老太太" },
            },
            {
              id: "evidence-1",
              domain: "evidence",
              intent: "create",
              target: { title: "原始材料摘要" },
              changes: { kind: "note", text: "贾母是荣国府老太太", origin: "用户输入" },
            },
          ],
        }),
      );
    });

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "extract",
      sourceMaterial: "贾母是荣国府老太太",
      persons: [],
      events: [],
      relations: [],
      includeArchive: true,
    });

    expect(result.facts?.[0]).toMatchObject({
      person: "贾母",
      key: "身份",
      value: "荣国府老太太",
      personDraftId: "plan:new-person",
    });
    expect(result.evidence?.[0]).toMatchObject({
      kind: "note",
      title: "原始材料摘要",
      text: "贾母是荣国府老太太",
      origin: "用户输入",
    });
  });

  it("rejects tool wandering during planning after two bounded repairs", async () => {
    askModelMock.mockImplementation(async (...args: unknown[]) => {
      const emit = args[4];
      if (typeof emit === "function") {
        emit(JSON.stringify({ type: "tool", tool: "get_person_by_name", args: { name: "唐悦" } }));
      }
    });
    await expect(
      runIntakeAgent({
        preset,
        extractionPrompt: "extract",
        sourceMaterial: "唐悦职务改为品牌总监",
        persons: [{ id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 }],
        events: [],
        relations: [],
        includeArchive: true,
        budget: {
          maxRounds: 12,
          maxToolCalls: 20,
          maxInputTokens: 40_000,
          maxOutputTokens: 8_000,
          maxWallTimeMs: 120_000,
        },
      }),
    ).rejects.toThrow("首轮必须返回 typed plan");
    expect(askModelMock).toHaveBeenCalledTimes(3);
  });

  it("updates an uncommitted workspace relation by recordRef instead of creating a second edge", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          {
            id: "correct-draft-relation",
            domain: "relation",
            intent: "update",
            target: {
              from: "唐悦",
              fromPersonId: "draft:person:tang",
              to: "周宁",
              toPersonId: "draft:person:zhou",
              relationId: "draft:relation:colleagues",
              label: "同事",
            },
            changes: {
              label: "前同事",
              basis: "原文：刚才写错了，他们不是现同事，是前同事",
            },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
      workspace: {
        _revision: 1,
        people: [
          { name: "唐悦", _draftId: "draft:person:tang" },
          { name: "周宁", _draftId: "draft:person:zhou" },
        ],
        relations: [
          {
            from: "唐悦",
            to: "周宁",
            label: "同事",
            basis: "原文：唐悦和周宁是同事",
            _draftId: "draft:relation:colleagues",
            fromDraftId: "draft:person:tang",
            toDraftId: "draft:person:zhou",
          },
        ],
      },
    });

    expect(compiled.staged.relations).toHaveLength(1);
    expect(compiled.staged.relations?.[0]).toMatchObject({
      _draftId: "draft:relation:colleagues",
      label: "前同事",
      fromDraftId: "draft:person:tang",
      toDraftId: "draft:person:zhou",
    });
    expect(compiled.staged._revision).toBe(2);
  });

  it("preserves manual field provenance while supplementing an uncommitted person", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          {
            id: "supplement-alice",
            domain: "person",
            intent: "update",
            target: { name: "Alice", personId: "draft:person:alice" },
            changes: { birthday: "03-12" },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
      workspace: {
        _revision: 1,
        people: [
          {
            name: "Alice",
            closeness: 4,
            _draftId: "draft:person:alice",
            _audit: {
              sourceSummary: "manual draft edit",
              extractedAt: 1,
              confirmationStatus: "pending",
              humanEdited: true,
            },
            _fieldGrounding: { closeness: { status: "manual" } },
          },
        ],
      },
    });

    expect(compiled.staged.people).toHaveLength(1);
    expect(compiled.staged.people?.[0]).toMatchObject({
      _draftId: "draft:person:alice",
      closeness: 4,
      birthday: "03-12",
      _audit: { humanEdited: true },
      _fieldGrounding: { closeness: { status: "manual" } },
    });
  });

  it("marks a projected sibling edge whose quoted source only names a shared parent", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          ...["Alice", "Bob", "Carol"].map((name) => ({
            id: `person-${name}`,
            domain: "person" as const,
            intent: "create" as const,
            target: { name },
            changes: {},
          })),
          {
            id: "invented-sibling",
            domain: "relation",
            intent: "create",
            target: {
              from: "Alice",
              fromPersonId: "plan:person-Alice",
              to: "Bob",
              toPersonId: "plan:person-Bob",
            },
            changes: {
              label: "sisters",
              basis: "Original: Alice and Bob are Carol's daughters.",
            },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
      sourceMaterial: "Alice and Bob are Carol's daughters.",
    });
    expect(compiled.staged.relations?.[0]).toMatchObject({
      _relationChecked: false,
      _relationReason: expect.stringContaining("经第三人关联"),
    });
  });

  it("accepts an explicit sibling claim and softly flags an incomplete plural-parent claim", () => {
    const explicitSibling = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          ...["Alice", "Bob"].map((name) => ({
            id: `person-${name}`,
            domain: "person" as const,
            intent: "create" as const,
            target: { name },
            changes: {},
          })),
          {
            id: "explicit-sibling",
            domain: "relation",
            intent: "create",
            target: {
              from: "Alice",
              fromPersonId: "plan:person-Alice",
              to: "Bob",
              toPersonId: "plan:person-Bob",
            },
            changes: { label: "sisters", basis: "Original: Alice and Bob are sisters." },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
      sourceMaterial: "Alice and Bob are sisters.",
    });
    expect(explicitSibling.staged.relations).toHaveLength(1);

    const incompleteParents = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          ...["Alex", "Sam", "Chris"].map((name) => ({
            id: `person-${name}`,
            domain: "person" as const,
            intent: "create" as const,
            target: { name },
            changes: {},
          })),
          {
            id: "parents",
            domain: "relation",
            intent: "create",
            target: {
              from: "Alex",
              fromPersonId: "plan:person-Alex",
              to: "Sam",
              toPersonId: "plan:person-Sam",
            },
            changes: { label: "spouses", basis: "Original: Alex and Sam are spouses." },
          },
          {
            id: "one-parent-only",
            domain: "relation",
            intent: "create",
            target: {
              from: "Alex",
              fromPersonId: "plan:person-Alex",
              to: "Chris",
              toPersonId: "plan:person-Chris",
            },
            changes: { label: "father", basis: "Original: Chris is their son." },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
      sourceMaterial: "Alex and Sam are spouses. Chris is their son.",
    });
    expect(
      incompleteParents.staged.relations?.find((relation) => relation.to === "Chris"),
    ).toMatchObject({
      _relationChecked: false,
      _relationReason: expect.stringContaining("另一位父母关系可能遗漏"),
    });
  });

  it("serializes only complete tool-history entries", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      call: { index },
      result: { text: "x".repeat(100) },
    }));
    const serialized = serializeIntakeHistory(history, 500);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized).length).toBeGreaterThan(0);
    expect(serialized.length).toBeLessThanOrEqual(500);
  });

  it("uses stable IDs to update one of two same-name people and the intended relation", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          {
            id: "update-second-zhang",
            domain: "person",
            intent: "update",
            target: { name: "张伟", personId: "zhang-2" },
            changes: { title: "产品经理" },
          },
          {
            id: "update-relation",
            domain: "relation",
            intent: "update",
            target: {
              from: "张伟",
              fromPersonId: "zhang-2",
              to: "周宁",
              toPersonId: "zhou",
              relationId: "relation-2",
              label: "同事",
            },
            changes: { label: "前同事", basis: "原文：张伟和周宁现在是前同事" },
          },
        ],
      },
      persons: [
        { id: "zhang-1", name: "张伟", note: "一号", descriptors: [], thumb: "", createdAt: 1 },
        { id: "zhang-2", name: "张伟", note: "二号", descriptors: [], thumb: "", createdAt: 2 },
        { id: "zhou", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 3 },
      ],
      relations: [
        {
          id: "relation-1",
          fromId: "zhang-1",
          toId: "zhou",
          label: "同事",
          basis: "原文：同事",
          createdAt: 1,
        },
        {
          id: "relation-2",
          fromId: "zhang-2",
          toId: "zhou",
          label: "同事",
          basis: "原文：同事",
          createdAt: 2,
        },
      ],
      events: [],
    });

    expect(compiled.staged.people?.[0]).toMatchObject({
      targetPersonId: "zhang-2",
      title: "产品经理",
    });
    expect(compiled.staged.relations?.[0]).toMatchObject({
      targetRelationId: "relation-2",
      fromPersonId: "zhang-2",
      toPersonId: "zhou",
      label: "前同事",
    });
  });

  it("treats 我 as the stable ego endpoint even before an ego record exists", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          {
            id: "roommates",
            domain: "relation",
            intent: "create",
            target: {
              from: "我",
              fromPersonId: "zhimai:self",
              to: "唐悦",
              toPersonId: "tang",
            },
            changes: { label: "室友", basis: "原文：我和唐悦是室友" },
          },
        ],
      },
      persons: [{ id: "tang", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 }],
      relations: [],
      events: [],
    });

    expect(compiled.staged.relations?.[0]).toMatchObject({
      fromPersonId: "zhimai:self",
      toPersonId: "tang",
      label: "室友",
    });
  });

  it("keeps two newly created same-name people distinct through plan references", () => {
    const compiled = compileIntakePlan({
      candidate: {
        type: "plan",
        tasks: [
          {
            id: "zhang-a",
            domain: "person",
            intent: "create",
            target: { name: "张伟" },
            changes: { title: "设计师" },
          },
          {
            id: "zhang-b",
            domain: "person",
            intent: "create",
            target: { name: "张伟" },
            changes: { title: "医生" },
          },
          {
            id: "same-name-friends",
            domain: "relation",
            intent: "create",
            target: {
              from: "张伟",
              fromPersonId: "plan:zhang-a",
              to: "张伟",
              toPersonId: "plan:zhang-b",
            },
            changes: { label: "朋友", basis: "原文：两个叫张伟的人是朋友" },
          },
        ],
      },
      persons: [],
      relations: [],
      events: [],
    });

    expect(compiled.staged.people).toHaveLength(2);
    expect(compiled.staged.people?.map((person) => person._draftId)).toEqual([
      "plan:zhang-a",
      "plan:zhang-b",
    ]);
    expect(compiled.staged.relations?.[0]).toMatchObject({
      fromDraftId: "plan:zhang-a",
      toDraftId: "plan:zhang-b",
    });
  });
});
