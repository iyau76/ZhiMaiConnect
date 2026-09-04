import { describe, expect, it } from "vitest";

import { resolveAssistantArchiveCitations } from "./agent-output-grounding";
import { ArchiveAgentReferenceSession } from "./archive-agent-reference-session";
import type { ArchiveAgentData } from "./archive-agent-tools";

type GroundingInput = Omit<
  Parameters<typeof resolveAssistantArchiveCitations>[0],
  "referenceSession"
>;

function fixtureSourceRef(
  sourceRef: unknown,
  archive: ArchiveAgentData,
  referenceSession: ArchiveAgentReferenceSession,
) {
  if (typeof sourceRef !== "string") return sourceRef;
  const match = /^(person|relation|event|collection):(.+)$/u.exec(sourceRef);
  if (!match) return sourceRef;
  const [, domain, stableId] = match;
  const label =
    domain === "person"
      ? archive.persons.find((person) => person.id === stableId)?.name
      : domain === "relation"
        ? archive.relations.find((relation) => relation.id === stableId)?.label
        : domain === "event"
          ? archive.events.find((event) => event.id === stableId)?.title
          : archive.collections?.find((collection) => collection.id === stableId)?.name;
  if (!label) return sourceRef;
  const handle = referenceSession.reference(
    domain as "person" | "relation" | "event" | "collection",
    stableId,
    label,
  ).handle;
  return `${domain}:${handle}`;
}

/** Tests express fixture identity readably, then cross the real opaque model boundary. */
function validateAssistantArchiveGrounding(options: GroundingInput) {
  const referenceSession = new ArchiveAgentReferenceSession(
    {
      ...options.archive,
      collections: options.archive.collections ?? [],
      collectionMemberships: options.archive.collectionMemberships ?? [],
    },
    "grounding-test",
  );
  const archiveClaims = Array.isArray(options.archiveClaims)
    ? options.archiveClaims.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
        const claim = raw as Record<string, unknown>;
        return {
          ...claim,
          sourceRef: fixtureSourceRef(claim.sourceRef, options.archive, referenceSession),
        };
      })
    : options.archiveClaims;
  return resolveAssistantArchiveCitations({ ...options, archiveClaims, referenceSession });
}

const archive = {
  persons: [
    {
      id: "doctor",
      name: "何澜",
      note: "心内科医生",
      descriptors: [],
      thumb: "",
      createdAt: 1,
    },
  ],
  relations: [],
  events: [],
};

describe("assistant archive grounding", () => {
  it("does not require citations before an archive answer can be shown", () => {
    const result = validateAssistantArchiveGrounding({
      question: "家中老人胸痛怎么办？",
      answer: "人物库里有心内科医生何澜。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result).toEqual({ ok: true, citations: [], evidenceText: undefined });
  });

  it("treats sourceRef as the selector and renders the canonical local fact", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是谁？",
      answer: "",
      archiveClaims: [{ sourceRef: "person:doctor", quote: "何澜" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("何澜：心内科医生");
    expect(result.evidenceText).not.toContain("原记录：“何澜”");
  });

  it("accepts a model-composed relation hint but renders a canonical local field", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜和小雨现在是什么关系？",
      answer: "建议按档案记录核对。",
      archiveClaims: [
        {
          sourceRef: "relation:former-colleagues",
          quote: "predicate:colleague_of；qualifiers.temporalStatus:former；label:前同事",
        },
      ],
      archive: {
        persons: [
          archive.persons[0],
          { id: "rain", name: "小雨", note: "", descriptors: [], thumb: "", createdAt: 1 },
        ],
        relations: [
          {
            id: "former-colleagues",
            fromId: "doctor",
            toId: "rain",
            label: "前同事",
            predicate: "colleague_of",
            qualifiers: { temporalStatus: "former" },
            mutual: true,
            createdAt: 1,
          },
        ],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("何澜与小雨：前同事");
    expect(result.evidenceText).toContain("原记录：“前同事”");
    expect(result.evidenceText).not.toContain("何澜与小雨：colleague_of");
  });

  it("collapses repeated model claims that resolve to the same local citation", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜和小雨现在是什么关系？",
      answer: "",
      archiveClaims: [
        { sourceRef: "relation:colleagues", quote: "label:同事" },
        { sourceRef: "relation:colleagues", quote: "predicate:colleague_of" },
        { sourceRef: "relation:colleagues", quote: "status:active" },
      ],
      archive: {
        persons: [
          archive.persons[0],
          { id: "rain", name: "小雨", note: "", descriptors: [], thumb: "", createdAt: 1 },
        ],
        relations: [
          {
            id: "colleagues",
            fromId: "doctor",
            toId: "rain",
            label: "同事",
            predicate: "colleague_of",
            mutual: true,
            createdAt: 1,
          },
        ],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([
      expect.objectContaining({
        sourceRef: expect.stringMatching(/^relation:ref_/u),
        quote: "同事",
      }),
    ]);
  });

  it("binds each short archive fact claim to a substantive canonical quote", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是做什么的？",
      answer: "建议先核对近期执业状态和联系方式。",
      archiveClaims: [{ sourceRef: "person:doctor", quote: "心内科医生" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("心内科医生");
  });

  it("selects an array fact by field path without asking the model to quote JSON", () => {
    const result = validateAssistantArchiveGrounding({
      question: "苏晚喜欢什么？",
      answer: "",
      archiveClaims: [{ sourceRef: "person:first-love", field: "likes" }],
      archive: {
        persons: [
          {
            id: "first-love",
            name: "苏晚",
            profile: { relation: "青梅竹马/初恋", likes: ["猫"] },
            note: "",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([
      expect.objectContaining({
        sourceRef: expect.stringMatching(/^person:ref_/u),
        field: "likes",
        quote: "猫",
      }),
    ]);
    expect(result.evidenceText).toContain("苏晚：猫");
  });

  it("treats an explicitly selected empty field as an auditable missing state", () => {
    const result = validateAssistantArchiveGrounding({
      question: "当前人物档案还缺哪些信息？",
      answer: "建议先补齐联系方式与相识时间。",
      archiveClaims: [
        { sourceRef: "person:doctor", field: "age" },
        { sourceRef: "person:doctor", field: "hasContact" },
        { sourceRef: "person:doctor", field: "aliases" },
      ],
      archive: {
        persons: [
          {
            id: "doctor",
            name: "何澜",
            profile: { age: "", contact: "", identities: [] },
            note: "心内科医生",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([
      expect.objectContaining({ field: "age", state: "missing", claim: "何澜：年龄未记录" }),
      expect.objectContaining({
        field: "hasContact",
        state: "missing",
        claim: "何澜：联系方式未记录",
      }),
      expect.objectContaining({
        field: "aliases",
        state: "missing",
        claim: "何澜：别名或账号未记录",
      }),
    ]);
  });

  it("ignores a field path that does not exist in the canonical source", () => {
    const result = validateAssistantArchiveGrounding({
      question: "当前人物档案还缺哪些信息？",
      answer: "",
      archiveClaims: [{ sourceRef: "person:doctor", field: "inventedField" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
  });

  it("does not block an uncited archive-completeness conclusion", () => {
    const result = validateAssistantArchiveGrounding({
      question: "当前人物档案库还缺哪些信息？",
      answer: "当前人物档案主要缺少联系方式与生日。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
  });

  it("keeps verified citations without deciding whether model prose may be shown", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是做什么的？",
      answer: "何澜：心内科医生兼国家主席。",
      archiveClaims: [{ sourceRef: "person:doctor", quote: "心内科医生" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("何澜：心内科医生");
    expect(result.evidenceText).not.toContain("国家主席");
  });

  it("renders contained names from separate stable sources without model-authored claims", () => {
    const result = validateAssistantArchiveGrounding({
      question: "分别介绍两人",
      answer: "",
      archiveClaims: [
        { sourceRef: "person:short", quote: "喜欢篮球" },
        { sourceRef: "person:long", quote: "喜欢童话" },
      ],
      archive: {
        persons: [
          { id: "short", name: "小王", note: "喜欢篮球", descriptors: [], thumb: "", createdAt: 1 },
          {
            id: "long",
            name: "小王子",
            note: "喜欢童话",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("小王：喜欢篮球");
    expect(result.evidenceText).toContain("小王子：喜欢童话");
  });

  it("disambiguates duplicate display names with human-readable context and no stable ID", () => {
    const result = validateAssistantArchiveGrounding({
      question: "张伟喜欢什么？",
      answer: "",
      archiveClaims: [{ sourceRef: "person:first", quote: "喜欢摄影" }],
      archive: {
        persons: [
          {
            id: "first",
            name: "张伟",
            profile: { org: "设计院" },
            note: "喜欢摄影",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
          {
            id: "second",
            name: "张伟",
            profile: { org: "学校" },
            note: "喜欢跑步",
            descriptors: [],
            thumb: "",
            createdAt: 2,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("张伟（设计院）：喜欢摄影");
    expect(result.evidenceText).toContain("[person:ref_");
    expect(result.evidenceText).not.toContain("person:first");
    expect(result.evidenceText).not.toContain("person:second");
  });

  it("does not gate a free-form language sentence about an archive person", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜这个名字怎么读？",
      answer: "何澜读作 hé lán。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
  });

  it("allows a separately validated non-archive answer channel to satisfy the question", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜这个名字怎么读？",
      answer: "",
      archiveClaims: [],
      archive,
      includeArchive: true,
      hasStructuredNonArchiveAnswer: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
  });

  it("does not gate a mixed pronunciation and archive answer", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是谁？另外中国怎么读？",
      answer: "何澜是国家主席。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ["何澜怎么读？", "何澜读作 he lan，并且是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan且是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan——她是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan/她是国家主席。"],
    ["何澜是谁？另外中国怎么读？", "何澜是国家主席，中国读作 zhong guo。"],
    ["何澜是谁？", "何澜使用拼音输入法，是国家主席。"],
  ])("does not gate neighbouring facts in a language answer", (question, answer) => {
    const result = validateAssistantArchiveGrounding({
      question,
      answer,
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
  });

  it("retains citations without censoring pronoun or omitted-subject prose", () => {
    for (const answer of ["她是国家主席。", "请记住她是国家主席。", "建议：还是国家主席。"]) {
      const result = validateAssistantArchiveGrounding({
        question: "何澜是谁？",
        answer,
        archiveClaims: [{ sourceRef: "person:doctor", quote: "心内科医生" }],
        archive,
        includeArchive: true,
      });
      expect(result.ok).toBe(true);
      expect(result.evidenceText).toContain("何澜：心内科医生");
      expect(result.evidenceText).not.toContain("国家主席");
    }
  });

  it("keeps valid citations when another model-provided reference is invalid", () => {
    const result = validateAssistantArchiveGrounding({
      archiveClaims: [
        { sourceRef: "person:doctor", field: "note" },
        { sourceRef: "person:missing", field: "note" },
      ],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      sourceRef: expect.stringMatching(/^person:ref_/u),
    });
  });

  it("rejects a raw stable person id at the model boundary", () => {
    const result = validateAssistantArchiveGrounding({
      archiveClaims: [{ sourceRef: "doctor", field: "note" }],
      archive,
      includeArchive: true,
    });

    expect(result.citations).toEqual([]);
  });

  it("resolves a producer namespace prefix against a flattened tool projection", () => {
    const result = validateAssistantArchiveGrounding({
      archiveClaims: [{ kind: "fact", sourceRef: "person:first-love", field: "profile.likes" }],
      archive: {
        persons: [
          {
            id: "first-love",
            name: "苏晚",
            profile: { likes: ["猫"] },
            note: "",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.citations).toEqual([
      expect.objectContaining({ field: "likes", quote: "猫", kind: "fact" }),
    ]);
  });

  it("treats the ego record as perspective instead of matching every Chinese pronoun 我", () => {
    const result = validateAssistantArchiveGrounding({
      question: "我的初恋是谁？",
      answer: "建议核对记录；如需修正，请告诉我。",
      archiveClaims: [{ sourceRef: "person:first-love", quote: "青梅竹马/初恋" }],
      archive: {
        persons: [
          {
            id: "zhimai:self",
            name: "我",
            entityRole: "ego" as const,
            note: "",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
          {
            id: "first-love",
            name: "苏晚",
            profile: { relation: "青梅竹马/初恋" },
            note: "",
            descriptors: [],
            thumb: "",
            createdAt: 1,
          },
        ],
        relations: [],
        events: [],
      },
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceText).toContain("苏晚：青梅竹马/初恋");
  });
});
