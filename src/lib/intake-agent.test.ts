import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_PROMPT_MAX_CHARACTERS } from "./ai-request-contract";
import { MemoryAgentRunRecorder } from "./agent-run-log";
import {
  IntakeAgentSuspendedError,
  runIntakeAgent,
  type IntakeAgentCheckpoint,
  type IntakeAgentResult,
} from "./intake-agent";
import { ModelTransportError } from "./model-transport-resilience";

const { askModelMock } = vi.hoisted(() => ({ askModelMock: vi.fn() }));
vi.mock("./vision-client", () => ({ askModel: askModelMock }));

const preset = {
  id: "test",
  name: "测试模型",
  kind: "openai" as const,
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

function answer(value: unknown) {
  return async (...args: unknown[]) => {
    (args[4] as (chunk: string) => void)(JSON.stringify(value));
  };
}

function classificationBatchContext(prompt: string) {
  const marker = "本批数据：";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("缺少分类批次上下文");
  return JSON.parse(prompt.slice(markerIndex + marker.length).trim()) as {
    taskRef: string;
    batchRef: string;
    people: Array<{ ref: string }>;
  };
}

function classificationBatchAnswer(prompt: string) {
  const context = classificationBatchContext(prompt);
  return {
    version: 1,
    type: "collection_classification_batch",
    taskRef: context.taskRef,
    batchRef: context.batchRef,
    assignments: context.people.map((person) => ({
      ref: person.ref,
      collections: [{ name: "校园伙伴" }],
    })),
  };
}

function collectionProposalSignature(result: IntakeAgentResult) {
  return (result.proposal?.operations ?? [])
    .filter((operation) => operation.kind === "organize_collection")
    .map((operation) => ({
      targetId: operation.replacement ? undefined : operation.targetId,
      replacement: operation.replacement
        ? { name: operation.replacement.name, kind: operation.replacement.kind }
        : undefined,
      memberships: [...operation.memberships]
        .map(({ personId, action }) => ({ personId, action }))
        .sort((left, right) =>
          `${left.personId}\0${left.action}`.localeCompare(`${right.personId}\0${right.action}`),
        ),
    }))
    .sort((left, right) =>
      `${left.targetId ?? left.replacement?.name}`.localeCompare(
        `${right.targetId ?? right.replacement?.name}`,
      ),
    );
}

describe("intake agent semantic path", () => {
  beforeEach(() => {
    askModelMock.mockReset();
  });

  it("asks for one semantic plan without exposing archive IDs or tool-writing instructions", async () => {
    askModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      expect(prompt.length).toBeLessThanOrEqual(AGENT_PROMPT_MAX_CHARACTERS);
      expect(prompt).toContain("semantic_plan");
      expect(prompt).toContain("UNDERSTAND");
      expect(prompt).toContain('"name":"唐悦"');
      expect(prompt).not.toContain("person-archive-secret");
      expect(prompt).not.toContain("只存在于档案索引的人");
      expect(prompt).not.toContain("stage_person_update");
      expect(prompt).not.toContain('"type":"final"');
      expect(prompt).not.toContain("LEGACY_OUTPUT_CONTRACT");
      (args[4] as (chunk: string) => void)(
        JSON.stringify({
          version: 1,
          type: "semantic_plan",
          summary: "补充唐悦职务",
          tasks: [
            {
              id: "person-tang",
              domain: "person",
              intent: "update",
              target: { kind: "person", name: "唐悦" },
              changes: { title: "品牌总监" },
            },
          ],
        }),
      );
    });

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: {
        knownContext: `唐悦 ${"已有上下文".repeat(1_500)}`,
        sourceMaterial: "唐悦升为品牌总监。",
      },
      persons: [
        {
          id: "person-archive-secret",
          name: "唐悦",
          note: "",
          descriptors: [],
          thumb: "",
          createdAt: 1,
        },
        {
          id: "another-archive-secret",
          name: "只存在于档案索引的人",
          note: "这段档案内容不应进入理解请求",
          descriptors: [],
          thumb: "",
          createdAt: 2,
        },
      ],
      relations: [],
      events: [],
      includeArchive: true,
      sourceMaterial: "唐悦升为品牌总监。",
    });

    expect(result.people?.[0]).toMatchObject({
      targetPersonId: "person-archive-secret",
      title: "品牌总监",
    });
    expect(result.intakeState.phase).toBe("AWAITING_APPROVAL");
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("resolves an existing event from the full local snapshot and stages its update", async () => {
    askModelMock.mockImplementationOnce(
      answer({
        version: 1,
        type: "semantic_plan",
        tasks: [
          {
            id: "event-dinner",
            domain: "event",
            intent: "update",
            target: { kind: "event", title: "团队聚餐" },
            changes: { date: "2026-09-02" },
          },
        ],
      }),
    );
    const original = {
      id: "event-1",
      title: "团队聚餐",
      date: "2026-09-01",
      precision: "day" as const,
      personIds: ["person-tang"],
      createdAt: 1,
    };

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "把日期改到 9 月 2 日",
      persons: [
        {
          id: "person-tang",
          name: "唐悦",
          note: "",
          descriptors: [],
          thumb: "",
          createdAt: 1,
        },
      ],
      events: [original],
      includeArchive: true,
      sourceMaterial: "团队聚餐改到 9 月 2 日",
    });

    expect(result.events?.[0]).toMatchObject({
      targetEventId: "event-1",
      title: "团队聚餐",
      date: "2026-09-02",
      people: ["唐悦"],
      peoplePersonIds: ["person-tang"],
    });
    expect(original.date).toBe("2026-09-01");
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("returns valid siblings when one reference is ambiguous", async () => {
    askModelMock.mockImplementationOnce(
      answer({
        version: 1,
        type: "semantic_plan",
        summary: "更新张伟并新增叶青",
        tasks: [
          {
            id: "ambiguous",
            domain: "person",
            intent: "update",
            target: { kind: "person", name: "张伟" },
            changes: { title: "负责人" },
          },
          {
            id: "valid",
            domain: "person",
            intent: "create",
            target: { kind: "person", name: "叶青" },
            changes: { title: "摄影师" },
          },
        ],
      }),
    );

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "整理人物",
      persons: [
        { id: "z1", name: "张伟", note: "", descriptors: [], thumb: "", createdAt: 1 },
        { id: "z2", name: "张伟", note: "", descriptors: [], thumb: "", createdAt: 2 },
      ],
      events: [],
      includeArchive: true,
      sourceMaterial: "整理人物",
    });

    expect(result.people?.map((person) => person.name)).toEqual(["叶青"]);
    expect(result.resolutionIssues).toEqual([
      expect.objectContaining({ taskId: "ambiguous", code: "ambiguous" }),
    ]);
    expect(result.intakeState.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task: expect.objectContaining({ id: "ambiguous" }),
          status: "needs_input",
        }),
        expect.objectContaining({
          task: expect.objectContaining({ id: "valid" }),
          status: "proposed",
        }),
      ]),
    );
    expect(askModelMock).toHaveBeenCalledTimes(1);
  });

  it("returns a formal collection mutation proposal", async () => {
    askModelMock.mockImplementationOnce(
      answer({
        version: 1,
        type: "semantic_plan",
        summary: "整理同事圈",
        tasks: [
          {
            id: "circle",
            domain: "collection",
            intent: "organize",
            target: {
              kind: "collection",
              name: "同事",
              collectionKind: "relationship_circle",
            },
            memberships: [{ people: { kind: "person_selection", scope: "all" }, action: "add" }],
          },
        ],
      }),
    );

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "把大家放进同事圈",
      persons: [
        { id: "p1", name: "唐悦", note: "", descriptors: [], thumb: "", createdAt: 1 },
        { id: "p2", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: 2 },
      ],
      events: [],
      collections: [
        {
          id: "work-circle",
          name: "同事",
          kind: "relationship_circle",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      collectionMemberships: [],
      includeArchive: true,
      sourceMaterial: "把大家放进同事圈",
    });

    expect(result.proposal?.operations).toEqual([
      expect.objectContaining({
        kind: "organize_collection",
        targetId: "work-circle",
        memberships: [
          expect.objectContaining({ personId: "p1", action: "add" }),
          expect.objectContaining({ personId: "p2", action: "add" }),
        ],
      }),
    ]);
  });

  it("does not enter a repair loop for an obsolete final or tool response", async () => {
    const recorder = new MemoryAgentRunRecorder({ runId: "no-repair-loop" });
    askModelMock.mockImplementationOnce(answer({ type: "final", draft: { summary: "旧格式" } }));

    await expect(
      runIntakeAgent({
        preset,
        extractionPrompt: "整理",
        persons: [],
        events: [],
        includeArchive: false,
        sourceMaterial: "整理",
        recorder,
      }),
    ).rejects.toThrow("semantic_plan");
    expect(askModelMock).toHaveBeenCalledTimes(1);
    expect(
      recorder
        .events()
        .filter((event) => event.kind === "validation")
        .some((event) => JSON.stringify(event.payload).includes("repair_requested")),
    ).toBe(false);
  });

  it.each([50, 500])(
    "classifies all %i people through opaque bounded batches and emits one formal collection operation",
    async (peopleCount) => {
      const persons = Array.from({ length: peopleCount }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        name: index % 7 === 0 ? "王晨" : `合成人物${index + 1}`,
        note: "校园记忆展协作伙伴",
        profile: { org: "合成工作室", title: "志愿者", tags: ["展览", "协作"] },
        descriptors: [],
        thumb: "",
        createdAt: index + 1,
      }));
      const modelPrompts: string[] = [];
      const modelOutputs: string[] = [];
      askModelMock.mockImplementation(async (...args: unknown[]) => {
        const prompt = String(args[1]);
        modelPrompts.push(prompt);
        let response: unknown;
        if (modelPrompts.length === 1) {
          response = {
            version: 1,
            type: "semantic_plan",
            summary: "整理全部人物圈层",
            tasks: [
              {
                id: "classify-all",
                domain: "collection",
                intent: "classify",
                target: { kind: "person_selection", scope: "all" },
              },
            ],
          };
        } else {
          const marker = "本批数据：";
          const markerIndex = prompt.lastIndexOf(marker);
          if (markerIndex < 0) {
            throw new Error(
              `没有找到分类批次：${prompt.slice(0, 80)}；参数=${args
                .map((value) => typeof value)
                .join(",")}`,
            );
          }
          const context = JSON.parse(prompt.slice(markerIndex + marker.length).trim());
          response = {
            version: 1,
            type: "collection_classification_batch",
            taskRef: context.taskRef,
            batchRef: context.batchRef,
            assignments: context.people.map((person: { ref: string }) => ({
              ref: person.ref,
              collections: [{ name: "校园伙伴" }],
            })),
          };
        }
        const text = JSON.stringify(response);
        modelOutputs.push(text);
        (args[4] as (chunk: string) => void)(text);
      });

      const result = await runIntakeAgent({
        preset,
        extractionPrompt: "请整理当前人物库的全部圈层",
        persons,
        events: [],
        relations: [],
        collections: [],
        collectionMemberships: [],
        includeArchive: true,
        sourceMaterial: "请整理当前人物库的全部圈层",
        budget: "deep",
      });

      expect(askModelMock.mock.calls.length).toBeGreaterThan(1);
      expect(askModelMock.mock.calls.length).toBeLessThanOrEqual(12);
      expect(modelPrompts.every((prompt) => prompt.length <= AGENT_PROMPT_MAX_CHARACTERS)).toBe(
        true,
      );
      for (const person of persons) {
        expect(modelPrompts.join("\n")).not.toContain(person.id);
        expect(modelOutputs.join("\n")).not.toContain(person.id);
      }
      expect(result.resolutionIssues).toEqual([]);
      expect(result.proposal?.operations).toEqual([
        expect.objectContaining({
          kind: "organize_collection",
          replacement: expect.objectContaining({ name: "校园伙伴" }),
          memberships: expect.arrayContaining(
            persons.map((person) =>
              expect.objectContaining({ personId: person.id, action: "add" }),
            ),
          ),
        }),
      ]);
      expect(result.proposal?.operations[0]).toMatchObject({
        memberships: expect.any(Array),
      });
      expect(
        result.proposal?.operations[0]?.kind === "organize_collection"
          ? result.proposal.operations[0].memberships
          : [],
      ).toHaveLength(peopleCount);
    },
    30_000,
  );

  it("isolates a malformed classification batch and preserves those people's memberships", async () => {
    const persons = Array.from({ length: 160 }, (_, index) => ({
      id: `person-secret-${index}`,
      name: `压力人物${index + 1}`,
      note: "这是一段只用于合成测试的较长人物摘要。".repeat(20),
      profile: {
        relation: "校园活动协作者",
        title: "跨部门项目志愿者",
        org: "合成校园记忆展工作组",
        department: "内容与视觉协作部门",
        tags: ["展览", "摄影", "设计", "志愿活动"],
        projects: ["校园记忆展", "毕业季影像计划", "校友口述史"],
      },
      descriptors: [],
      thumb: "",
      createdAt: index + 1,
    }));
    let call = 0;
    let failedBatchSize = 0;
    askModelMock.mockImplementation(async (...args: unknown[]) => {
      call += 1;
      const prompt = String(args[1]);
      let response: unknown;
      if (call === 1) {
        response = {
          version: 1,
          type: "semantic_plan",
          tasks: [
            {
              id: "classify-partial",
              domain: "collection",
              intent: "classify",
              target: { kind: "person_selection", scope: "all" },
            },
          ],
        };
      } else {
        const marker = "本批数据：";
        const context = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim());
        if (call === 2) {
          failedBatchSize = context.people.length;
          response = { type: "wrong_batch_contract" };
        } else {
          response = {
            version: 1,
            type: "collection_classification_batch",
            taskRef: context.taskRef,
            batchRef: context.batchRef,
            assignments: context.people.map((person: { ref: string }) => ({
              ref: person.ref,
              collections: [{ name: "新圈层" }],
            })),
          };
        }
      }
      (args[4] as (chunk: string) => void)(JSON.stringify(response));
    });

    const result = await runIntakeAgent({
      preset,
      extractionPrompt: "重新整理所有圈层",
      persons,
      events: [],
      relations: [],
      collections: [
        {
          id: "old-circle",
          name: "旧圈层",
          kind: "relationship_circle",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      collectionMemberships: persons.map((person) => ({
        id: `old-circle\0${person.id}`,
        collectionId: "old-circle",
        personId: person.id,
        source: "manual" as const,
        createdAt: 1,
      })),
      includeArchive: true,
      sourceMaterial: "重新整理所有圈层",
      budget: "deep",
    });

    expect(call).toBeGreaterThan(2);
    expect(failedBatchSize).toBeGreaterThan(0);
    expect(result.resolutionIssues).toEqual([
      expect.objectContaining({
        taskId: "classify-partial",
        code: "invalid",
        message: expect.stringContaining("返回格式无效"),
      }),
    ]);
    const oldCircle = result.proposal?.operations.find(
      (operation) =>
        operation.kind === "organize_collection" && operation.targetId === "old-circle",
    );
    expect(oldCircle?.kind === "organize_collection" ? oldCircle.memberships : []).toHaveLength(
      persons.length - failedBatchSize,
    );
  }, 30_000);

  it("resumes from the failed collection batch without repeating completed model work", async () => {
    const persons = Array.from({ length: 180 }, (_, index) => ({
      id: `stable-archive-person-${String(index + 1).padStart(4, "0")}`,
      name: index % 11 === 0 ? "王晨" : `合成协作者${index + 1}`,
      note: "这是一段足以触发多批次分类的合成人物摘要。".repeat(18),
      profile: {
        relation: "校园活动协作者",
        title: "跨部门项目志愿者",
        org: "合成校园记忆展工作组",
        department: "内容与视觉协作部门",
        tags: ["展览", "摄影", "设计", "志愿活动"],
        projects: ["校园记忆展", "毕业季影像计划", "校友口述史"],
      },
      descriptors: [],
      thumb: "",
      createdAt: index + 1,
    }));
    const semanticPlan = {
      version: 1,
      type: "semantic_plan",
      summary: "整理全部人物圈层",
      tasks: [
        {
          id: "classify-resumable",
          domain: "collection",
          intent: "classify",
          target: { kind: "person_selection", scope: "all" },
        },
      ],
    };
    const sharedOptions = {
      preset,
      extractionPrompt: "请整理当前人物库的全部圈层",
      persons,
      events: [],
      relations: [],
      collections: [],
      collectionMemberships: [],
      includeArchive: true,
      sourceMaterial: "请整理当前人物库的全部圈层",
      budget: "deep" as const,
      transportRetry: { maxAttempts: 1, delaysMs: [] },
    };

    const interruptedPrompts: string[] = [];
    const interruptedCheckpoints: IntakeAgentCheckpoint[] = [];
    let classificationRequest = 0;
    askModelMock.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      interruptedPrompts.push(prompt);
      if (!prompt.includes("本批数据：")) {
        (args[4] as (chunk: string) => void)(JSON.stringify(semanticPlan));
        return;
      }
      classificationRequest += 1;
      if (classificationRequest === 2) {
        throw new ModelTransportError("上游暂时不可用", 503, "UPSTREAM_UNAVAILABLE");
      }
      (args[4] as (chunk: string) => void)(JSON.stringify(classificationBatchAnswer(prompt)));
    });

    let suspended: IntakeAgentSuspendedError | undefined;
    try {
      await runIntakeAgent({
        ...sharedOptions,
        onCheckpoint: async (checkpoint) => {
          await Promise.resolve();
          interruptedCheckpoints.push(checkpoint);
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(IntakeAgentSuspendedError);
      suspended = error as IntakeAgentSuspendedError;
    }
    if (!suspended) throw new Error("预期 intake 在第二个分类批次暂停");

    expect(suspended.reason).toBe("transport");
    expect(suspended.checkpoint.nextAction).toBe("classify_collections");
    expect(suspended.checkpoint.completedBatchKeys).toHaveLength(1);
    expect(suspended.checkpoint.consumedBudget.rounds).toBe(2);
    expect(() => JSON.stringify(suspended?.checkpoint)).not.toThrow();
    expect(interruptedCheckpoints.map((checkpoint) => checkpoint.nextAction)).toEqual([
      "understand",
      "classify_collections",
      "classify_collections",
    ]);

    const completedBatchRef = JSON.parse(suspended.checkpoint.completedBatchKeys[0])?.[1];
    const resumedPrompts: string[] = [];
    const resumedCheckpoints: IntakeAgentCheckpoint[] = [];
    askModelMock.mockReset();
    askModelMock.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      resumedPrompts.push(prompt);
      if (!prompt.includes("本批数据：")) throw new Error("恢复时不应再次请求 semantic_plan");
      (args[4] as (chunk: string) => void)(JSON.stringify(classificationBatchAnswer(prompt)));
    });
    const resumedResult = await runIntakeAgent({
      ...sharedOptions,
      resumeFrom: suspended.checkpoint,
      onCheckpoint: (checkpoint) => {
        resumedCheckpoints.push(checkpoint);
      },
    });
    const resumedBatchRefs = resumedPrompts.map(
      (prompt) => classificationBatchContext(prompt).batchRef,
    );
    expect(resumedBatchRefs).not.toContain(completedBatchRef);
    expect(resumedCheckpoints.at(-2)?.nextAction).toBe("compile");
    expect(resumedCheckpoints.at(-1)?.nextAction).toBe("complete");
    expect(resumedCheckpoints.at(-1)?.completedResult).toEqual(resumedResult);
    for (const prompt of [...interruptedPrompts, ...resumedPrompts]) {
      for (const person of persons) expect(prompt).not.toContain(person.id);
    }

    askModelMock.mockReset();
    askModelMock.mockImplementation(async (...args: unknown[]) => {
      const prompt = String(args[1]);
      const response = prompt.includes("本批数据：")
        ? classificationBatchAnswer(prompt)
        : semanticPlan;
      (args[4] as (chunk: string) => void)(JSON.stringify(response));
    });
    const uninterruptedResult = await runIntakeAgent(sharedOptions);
    expect(resumedResult.resolutionIssues).toEqual(uninterruptedResult.resolutionIssues);
    expect(collectionProposalSignature(resumedResult)).toEqual(
      collectionProposalSignature(uninterruptedResult),
    );

    const completedCheckpoint = resumedCheckpoints.at(-1)!;
    askModelMock.mockReset();
    askModelMock.mockImplementation(() => {
      throw new Error("已完成断点不应再调用模型");
    });
    const restoredCompletedResult = await runIntakeAgent({
      ...sharedOptions,
      resumeFrom: completedCheckpoint,
    });
    expect(restoredCompletedResult).toEqual(completedCheckpoint.completedResult);
    expect(askModelMock).not.toHaveBeenCalled();
  }, 30_000);
});
