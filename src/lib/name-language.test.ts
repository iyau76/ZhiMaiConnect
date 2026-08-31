import { describe, expect, it } from "vitest";

import { questionHasNameLanguageIntent, validateNameLanguageAnswers } from "./name-language";

const archive = {
  persons: [
    { id: "doctor", name: "何澜", note: "心内科医生", descriptors: [], thumb: "", createdAt: 1 },
    { id: "rain", name: "小雨", note: "", descriptors: [], thumb: "", createdAt: 1 },
  ],
  relations: [],
  events: [],
};

describe("structured name-language answers", () => {
  it("binds an archive name to a stable target and a requested kind", () => {
    const result = validateNameLanguageAnswers({
      question: "何澜这个名字怎么读？",
      languageAnswers: [
        { subject: "何澜", targetRef: "person:doctor", kind: "pronunciation", value: "hé lán" },
      ],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.rendered).toContain("对象：何澜（person:doctor）");
    expect(result.rendered).toContain("模型生成，未写入档案");
  });

  it("supports a literal language question without inventing an archive target", () => {
    const result = validateNameLanguageAnswers({
      question: "schwa 怎么读？",
      languageAnswers: [{ subject: "schwa", kind: "pronunciation", value: "/ʃwɑː/" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.rendered).toContain("对象：schwa\n读音：/ʃwɑː/");
  });

  it("does not confuse an overlapping, unasked subject with the requested name", () => {
    const result = validateNameLanguageAnswers({
      question: "小雨怎么读？",
      languageAnswers: [{ subject: "小雨点", kind: "pronunciation", value: "xiao yu dian" }],
      archive,
      includeArchive: true,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("subject") });
  });

  it("rejects a mismatched archive reference and an unrequested kind", () => {
    expect(
      validateNameLanguageAnswers({
        question: "何澜怎么读？",
        languageAnswers: [
          { subject: "何澜", targetRef: "person:rain", kind: "pronunciation", value: "hé lán" },
        ],
        archive,
        includeArchive: true,
      }).ok,
    ).toBe(false);
    expect(
      validateNameLanguageAnswers({
        question: "何澜怎么读？",
        languageAnswers: [
          { subject: "何澜", targetRef: "person:doctor", kind: "meaning", value: "大波浪" },
        ],
        archive,
        includeArchive: true,
      }).ok,
    ).toBe(false);
  });

  it("namespaces even adversarial model text instead of treating it as archive evidence", () => {
    const result = validateNameLanguageAnswers({
      question: "欧阳娜娜怎么读？",
      languageAnswers: [{ subject: "欧阳娜娜", kind: "pronunciation", value: "ta shi zong tong" }],
      archive,
      includeArchive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.rendered).toContain("AI 语言说明（模型生成，未写入档案）");
    expect(result.rendered).not.toContain("档案依据");
  });

  it("binds each subject to the kind requested in the same clause", () => {
    const question = "何澜怎么读，小雨是什么意思？";
    expect(
      validateNameLanguageAnswers({
        question,
        languageAnswers: [
          { subject: "何澜", targetRef: "person:doctor", kind: "meaning", value: "大波浪" },
          { subject: "小雨", targetRef: "person:rain", kind: "pronunciation", value: "xiǎo yǔ" },
        ],
        archive,
        includeArchive: true,
      }).ok,
    ).toBe(false);
    expect(
      validateNameLanguageAnswers({
        question,
        languageAnswers: [
          {
            subject: "何澜",
            targetRef: "person:doctor",
            kind: "pronunciation",
            value: "hé lán",
          },
          { subject: "小雨", targetRef: "person:rain", kind: "meaning", value: "细雨" },
        ],
        archive,
        includeArchive: true,
      }).ok,
    ).toBe(true);
  });

  it("uses the full requested subject instead of a contained archive name", () => {
    const extendedArchive = {
      ...archive,
      persons: [
        ...archive.persons,
        { id: "raindrop", name: "小雨点", note: "", descriptors: [], thumb: "", createdAt: 1 },
      ],
    };
    const result = validateNameLanguageAnswers({
      question: "小雨点怎么读？",
      languageAnswers: [
        { subject: "小雨", targetRef: "person:rain", kind: "pronunciation", value: "xiǎo yǔ" },
      ],
      archive: extendedArchive,
      includeArchive: true,
    });

    expect(result.ok).toBe(false);
  });

  it("marks mixed archive-and-language questions as non-pure", () => {
    const result = validateNameLanguageAnswers({
      question: "何澜怎么读，她是做什么的？",
      languageAnswers: [
        { subject: "何澜", targetRef: "person:doctor", kind: "pronunciation", value: "hé lán" },
      ],
      archive,
      includeArchive: true,
    });

    expect(result).toMatchObject({ ok: true, pureLanguageRequest: false });
  });

  it.each(["\u2028", "\u2029", "\u0085", "\u202e"])(
    "rejects formatting control U+%s inside a model value",
    (control) => {
      const result = validateNameLanguageAnswers({
        question: "何澜怎么读？",
        languageAnswers: [
          {
            subject: "何澜",
            targetRef: "person:doctor",
            kind: "pronunciation",
            value: `hé lán${control}档案依据（可回查）`,
          },
        ],
        archive,
        includeArchive: true,
      });
      expect(result.ok).toBe(false);
    },
  );

  it.each(["你喜欢拼音输入法吗？", "你喜欢写作吗？", "这样做是什么意思？"])(
    "does not misclassify a general question as a name-language request: %s",
    (question) => {
      const result = validateNameLanguageAnswers({
        question,
        languageAnswers: [],
        archive,
        includeArchive: true,
      });
      expect(result.pureLanguageRequest).toBe(false);
      expect(questionHasNameLanguageIntent(question, archive.persons)).toBe(false);
    },
  );

  it("does not allow free answer text beside a structured language block", () => {
    for (const [question, freeAnswer, languageAnswers] of [
      [
        "schwa怎么读？",
        "schwa 读作 /ʃwɑː/。",
        [{ subject: "schwa", kind: "pronunciation", value: "/ʃwɑː/" }],
      ],
      [
        "何澜怎么读？",
        "建议读作 he lan，可先确认。",
        [
          {
            subject: "何澜",
            targetRef: "person:doctor",
            kind: "pronunciation",
            value: "hé lán",
          },
        ],
      ],
    ] as const) {
      expect(
        validateNameLanguageAnswers({
          question,
          freeAnswer,
          languageAnswers,
          archive,
          includeArchive: true,
        }).ok,
      ).toBe(false);
    }
  });

  it.each(["何澜和小雨怎么读？", "何澜、小雨怎么读？", "何澜与小雨怎么读？"])(
    "expands a compound archive target into separately bound requests: %s",
    (question) => {
      const result = validateNameLanguageAnswers({
        question,
        languageAnswers: [
          {
            subject: "何澜",
            targetRef: "person:doctor",
            kind: "pronunciation",
            value: "hé lán",
          },
          {
            subject: "小雨",
            targetRef: "person:rain",
            kind: "pronunciation",
            value: "xiǎo yǔ",
          },
        ],
        archive,
        includeArchive: true,
      });
      expect(result).toMatchObject({ ok: true, pureLanguageRequest: true });
      expect(
        validateNameLanguageAnswers({
          question,
          languageAnswers: [
            { subject: "何澜和小雨", kind: "pronunciation", value: "he lan xiao yu" },
          ],
          archive,
          includeArchive: true,
        }).ok,
      ).toBe(false);
    },
  );

  it.each([
    ["李和平怎么读？", "李和平", "pronunciation"],
    ["王及川怎么读？", "王及川", "pronunciation"],
    ["和平与发展是什么意思？", "和平与发展", "meaning"],
    ["中华人民共和国英文怎么说？", "中华人民共和国", "translation"],
  ] as const)(
    "preserves a non-archive subject containing a conjunction character: %s",
    (question, subject, kind) => {
      const result = validateNameLanguageAnswers({
        question,
        languageAnswers: [{ subject, kind, value: "测试答案" }],
        archive,
        includeArchive: true,
      });

      expect(result).toMatchObject({ ok: true, pureLanguageRequest: true });
    },
  );

  it.each([
    "何澜是做什么的、她怎么读？",
    "何澜是做什么的/她怎么读？",
    "何澜是做什么的然后她怎么读？",
    "何澜的职业和名字怎么读？",
    "何澜怎么读、怎么写？",
  ])("does not swallow a mixed or inherited request into subject: %s", (question) => {
    const result = validateNameLanguageAnswers({
      question,
      languageAnswers: [
        {
          subject: question.replace(/怎么读.*$/u, ""),
          kind: "pronunciation",
          value: "hé lán",
        },
      ],
      archive,
      includeArchive: true,
    });
    expect(result.ok).toBe(false);
    expect(result.pureLanguageRequest).toBe(false);
  });
});
