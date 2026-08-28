import { describe, expect, it } from "vitest";

import { validateAssistantArchiveGrounding } from "./agent-output-grounding";

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
  it("returns canonical citation candidates for a named local person", () => {
    const result = validateAssistantArchiveGrounding({
      question: "家中老人胸痛怎么办？",
      answer: "人物库里有心内科医生何澜。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result).toMatchObject({
      ok: false,
      repairCitations: [
        {
          sourceRef: "person:doctor",
          quote: "心内科医生",
          claim: "何澜：心内科医生",
        },
      ],
    });
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
      expect.objectContaining({ sourceRef: "relation:colleagues", quote: "同事" }),
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
      expect.objectContaining({ sourceRef: "person:first-love", field: "likes", quote: "猫" }),
    ]);
    expect(result.evidenceText).toContain("苏晚：猫");
  });

  it("keeps verified citations and discards facts smuggled into model commentary", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是做什么的？",
      answer: "何澜：心内科医生兼国家主席。",
      archiveClaims: [{ sourceRef: "person:doctor", quote: "心内科医生" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.includeModelAnswer).toBe(false);
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

  it("renders a visible stable marker for duplicate display names", () => {
    const result = validateAssistantArchiveGrounding({
      question: "张伟喜欢什么？",
      answer: "",
      archiveClaims: [{ sourceRef: "person:first", quote: "喜欢摄影" }],
      archive: {
        persons: [
          { id: "first", name: "张伟", note: "喜欢摄影", descriptors: [], thumb: "", createdAt: 1 },
          {
            id: "second",
            name: "张伟",
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
    expect(result.evidenceText).toContain("person:first");
    expect(result.evidenceText).not.toContain("person:second");
  });

  it("does not exempt a free-form language sentence about an archive person", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜这个名字怎么读？",
      answer: "何澜读作 hé lán。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(false);
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

  it("does not let a mixed pronunciation sub-question disable archive grounding", () => {
    const result = validateAssistantArchiveGrounding({
      question: "何澜是谁？另外中国怎么读？",
      answer: "何澜是国家主席。",
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(false);
  });

  it.each([
    ["何澜怎么读？", "何澜读作 he lan，并且是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan且是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan——她是国家主席。"],
    ["何澜怎么读？", "何澜读作 he lan/她是国家主席。"],
    ["何澜是谁？另外中国怎么读？", "何澜是国家主席，中国读作 zhong guo。"],
    ["何澜是谁？", "何澜使用拼音输入法，是国家主席。"],
  ])("does not let a language clause exempt neighbouring facts", (question, answer) => {
    const result = validateAssistantArchiveGrounding({
      question,
      answer,
      archiveClaims: [],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(false);
  });

  it("discards pronoun and omitted-subject facts while retaining verified citations", () => {
    for (const answer of ["她是国家主席。", "请记住她是国家主席。", "建议：还是国家主席。"]) {
      const result = validateAssistantArchiveGrounding({
        question: "何澜是谁？",
        answer,
        archiveClaims: [{ sourceRef: "person:doctor", quote: "心内科医生" }],
        archive,
        includeArchive: true,
      });
      expect(result.ok).toBe(true);
      expect(result.includeModelAnswer).toBe(false);
      expect(result.evidenceText).toContain("何澜：心内科医生");
      expect(result.evidenceText).not.toContain("国家主席");
    }
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
