import { describe, expect, it } from "vitest";
import {
  ARCHIVE_V2_SCHEMA,
  ArchiveValidationError,
  archiveRestorePlan,
  createArchiveV2,
  normalizeArchive,
  type ArchiveV2Source,
} from "./archive-data";

const at = 1_788_000_000_000;

function source(): ArchiveV2Source {
  return {
    persons: [
      {
        id: "self",
        name: "我",
        note: "本人",
        profile: { contact: "13800000000", circle: "朋友", closeness: 3.5 },
        descriptors: [[0.1, 0.2]],
        thumb: "data:image/jpeg;base64,face",
        photos: [{ id: "photo-person", dataUrl: "data:image/jpeg;base64,x", addedAt: at }],
        createdAt: at,
        entityRole: "ego",
        identityScopeId: "scope-self",
      },
      {
        id: "friend",
        name: "唐悦",
        note: "前同事",
        descriptors: [],
        thumb: "",
        createdAt: at + 1,
        entityRole: "contact",
      },
    ],
    relationAssertions: [
      {
        id: "assertion-1",
        recordType: "assertion",
        fromId: "self",
        toId: "friend",
        predicate: "colleague_of",
        qualifiers: { temporalStatus: "former" },
        label: "前同事",
        direction: "ontology",
        evidence: { mode: "source_claim", basis: "原文：以前共事", sourceIds: ["evidence-1"] },
        validity: { status: "ended" },
        confidence: 0.95,
        confirmationStatus: "confirmed",
        createdAt: at,
        updatedAt: at + 2,
      },
    ],
    derivedRelations: [
      {
        id: "derived-1",
        recordType: "derived",
        fromId: "self",
        toId: "friend",
        predicate: "friend_of",
        qualifiers: {},
        label: "朋友",
        confidence: 0.7,
        ruleId: "test.rule",
        ruleVersion: 1,
        supportingRelationIds: ["assertion-1"],
        explanation: "测试投影",
      },
    ],
    relationEvidenceLinks: [
      {
        id: "link-1",
        assertionId: "assertion-1",
        evidenceId: "evidence-1",
        excerpt: "以前共事",
        createdAt: at,
      },
    ],
    relationViewPreferences: [
      { id: "view-1", subjectId: "derived-1", visibility: "hidden", updatedAt: at },
    ],
    referralPolicies: [
      {
        id: "policy-1",
        subjectId: "assertion-1",
        policy: "avoid",
        direction: "both",
        contexts: ["借钱"],
        updatedAt: at,
      },
    ],
    collections: [
      { id: "collection-1", name: "虚构", kind: "context", createdAt: at, updatedAt: at },
    ],
    collectionMemberships: [
      {
        id: "membership-1",
        collectionId: "collection-1",
        personId: "friend",
        source: "ai_approved",
        createdAt: at,
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        kind: "note",
        title: "聊天记录",
        text: "以前共事",
        thumb: "data:image/jpeg;base64,evidence",
        entities: [{ type: "person", value: "唐悦", personId: "friend" }],
        linkedPersonIds: ["friend"],
        createdAt: at,
      },
    ],
    caseEvents: [
      {
        id: "case-1",
        at,
        title: "确认经历",
        certainty: "fact",
        personIds: ["friend"],
        evidenceIds: ["evidence-1"],
        createdAt: at,
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "联系唐悦",
        personIds: ["friend"],
        priority: "normal",
        status: "todo",
        createdAt: at,
      },
    ],
    projects: [
      {
        id: "project-1",
        title: "品牌活动",
        ownerId: "friend",
        memberIds: ["self"],
        status: "active",
        priority: "high",
        createdAt: at,
      },
    ],
    lifeEvents: [
      {
        id: "event-1",
        date: "2026-09-01",
        precision: "month",
        dateText: "今年九月",
        title: "团队聚餐",
        personIds: ["friend"],
        photos: [{ id: "photo-event", dataUrl: "data:image/jpeg;base64,y", addedAt: at }],
        createdAt: at,
      },
    ],
    reminders: [
      {
        id: "reminder-1",
        title: "提醒聚餐",
        personIds: ["friend"],
        done: false,
        completionEventId: "event-1",
        createdAt: at,
      },
    ],
    meetingBriefs: [
      {
        id: "brief-1",
        seriesId: "brief-1",
        personId: "friend",
        personName: "唐悦",
        title: "见面前看看：唐悦",
        sourceRevision: "revision-1",
        sourceRefs: [
          { kind: "person", id: "friend", revision: "person-r1" },
          { kind: "event", id: "event-1", revision: "event-r1" },
        ],
        content: {
          profile: [
            {
              text: "前同事",
              sources: [{ kind: "person", id: "friend", revision: "person-r1" }],
            },
          ],
          recentEvents: [
            {
              text: "今年九月 · 团队聚餐",
              sources: [{ kind: "event", id: "event-1", revision: "event-r1" }],
            },
          ],
          openItems: [],
          relatedPeople: [],
          talkingPoints: [],
          gaps: ["还没有联系方式"],
        },
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
}

describe("archive@2 machine contract", () => {
  it("round-trips every durable v13 record while explicitly excluding media, biometrics and secrets", () => {
    const archive = createArchiveV2(source(), {
      exportedAt: "2026-08-28T10:00:00.000Z",
      appVersion: "test",
    });

    expect(archive.schema).toBe(ARCHIVE_V2_SCHEMA);
    expect(archive.records.persons[0]).toMatchObject({
      id: "self",
      entityRole: "ego",
      identityScopeId: "scope-self",
      profile: { contact: "13800000000", closeness: 3.5 },
    });
    expect(archive.records.persons[0].profile).not.toHaveProperty("circle");
    expect(archive.records).toMatchObject({
      relationAssertions: [{ id: "assertion-1" }],
      relationEvidenceLinks: [{ id: "link-1" }],
      relationViewPreferences: [{ id: "view-1" }],
      referralPolicies: [{ id: "policy-1" }],
      collections: [{ id: "collection-1" }],
      collectionMemberships: [{ id: "membership-1" }],
      evidence: [{ id: "evidence-1" }],
      caseEvents: [{ id: "case-1" }],
      tasks: [{ id: "task-1" }],
      projects: [{ id: "project-1" }],
      lifeEvents: [{ id: "event-1" }],
      reminders: [{ id: "reminder-1" }],
      meetingBriefs: [{ id: "brief-1" }],
    });
    expect(archive.projectionDiagnostics).toMatchObject({
      importPolicy: "discard-and-rebuild",
      derivedRelations: [{ id: "derived-1" }],
    });

    const json = JSON.stringify(archive);
    const recordJson = JSON.stringify(archive.records);
    expect(recordJson).not.toContain("descriptors");
    expect(recordJson).not.toContain("data:image");
    expect(recordJson).not.toContain("API key");
    expect(archive.privacy.omissions.map((item) => item.category)).toEqual([
      "photos",
      "biometrics",
      "credentials",
      "runtime_private_data",
    ]);

    const normalized = normalizeArchive(json);
    expect(normalized.sourceSchema).toBe(ARCHIVE_V2_SCHEMA);
    expect(normalized.warnings).toEqual([]);
    expect(normalized.archive).toEqual(archive);
  });

  it("never restores the diagnostic projection as asserted facts", () => {
    const archive = createArchiveV2(source());
    const plan = archiveRestorePlan(archive);
    expect(plan.sourceSchema).toBe(ARCHIVE_V2_SCHEMA);
    expect(plan.privacy.mode).toBe("safe-default");
    expect(plan.records.relationAssertions.map((item) => item.id)).toEqual(["assertion-1"]);
    expect(plan.records).not.toHaveProperty("derivedRelations");
    expect(plan.rebuildDerivedRelations).toBe(true);
    expect(plan.discardedProjectionCount).toBe(1);
  });

  it("keeps archive@2 files produced by data model v11 readable after the v13 upgrade", () => {
    const previous = structuredClone(createArchiveV2(source()));
    previous.generator.dataModelVersion = 11;
    expect(normalizeArchive(previous).archive.generator.dataModelVersion).toBe(11);
  });

  it("loads data model v12 archives without meeting briefs", () => {
    const previous = structuredClone(createArchiveV2(source())) as unknown as {
      generator: { dataModelVersion: 12 };
      records: Record<string, unknown>;
    };
    previous.generator.dataModelVersion = 12;
    delete previous.records.meetingBriefs;

    const normalized = normalizeArchive(previous).archive;
    expect(normalized.generator.dataModelVersion).toBe(12);
    expect(normalized.records.meetingBriefs).toEqual([]);
  });

  it("rejects unknown fields, duplicate ids and dangling references", () => {
    const withSecretField = structuredClone(createArchiveV2(source())) as unknown as {
      records: { persons: Array<Record<string, unknown>> };
    };
    withSecretField.records.persons[0].descriptors = [];
    expect(() => normalizeArchive(withSecretField)).toThrow(ArchiveValidationError);

    const duplicates = structuredClone(createArchiveV2(source()));
    duplicates.records.persons.push(structuredClone(duplicates.records.persons[0]));
    expect(() => normalizeArchive(duplicates)).toThrowError(/引用完整性/);

    const dangling = structuredClone(createArchiveV2(source()));
    dangling.records.projects[0].ownerId = "missing-person";
    try {
      normalizeArchive(dangling);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).issues.join("\n")).toContain("missing-person");
    }

    const divergentEvidenceTruth = structuredClone(createArchiveV2(source()));
    divergentEvidenceTruth.records.relationEvidenceLinks = [];
    try {
      normalizeArchive(divergentEvidenceTruth);
      throw new Error("expected evidence-link validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).issues.join("\n")).toContain(
        "缺少对应 evidenceLink",
      );
    }

    const danglingCompletion = structuredClone(createArchiveV2(source()));
    danglingCompletion.records.reminders[0].completionEventId = "missing-event";
    try {
      normalizeArchive(danglingCompletion);
      throw new Error("expected completion event validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).issues.join("\n")).toContain("missing-event");
    }

    const danglingBrief = structuredClone(createArchiveV2(source()));
    danglingBrief.records.meetingBriefs[0].personId = "missing-person";
    try {
      normalizeArchive(danglingBrief);
      throw new Error("expected meeting brief validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect((error as ArchiveValidationError).issues.join("\n")).toContain("missing-person");
    }
  });
});

describe("legacy backup migration", () => {
  it("imports archive@1, promotes only explicit facts and migrates circles/policies", () => {
    const legacy = {
      schema: "zhimai-connect/archive@1",
      exportedAt: "2026-08-28T10:00:00.000Z",
      persons: [
        {
          id: "zhimai:self",
          name: "我",
          note: "",
          profile: { circle: "亲戚" },
          descriptors: [[0.1]],
          thumb: "data:image/jpeg;base64,face",
          photos: [{ id: "p", dataUrl: "data:image/png;base64,p", addedAt: at }],
          createdAt: at,
        },
        {
          id: "person-2",
          name: "贾母",
          note: "",
          descriptors: [],
          thumb: "",
          createdAt: at,
        },
      ],
      relations: [
        {
          id: "fact",
          fromId: "zhimai:self",
          toId: "person-2",
          label: "母女",
          basis: "原文：贾母是我的母亲",
          sourceId: "v1-source-not-exported",
          evidenceMode: "explicit",
          confidence: 0.95,
          visibility: "always",
          recommendationPolicy: "allow",
          createdAt: at,
        },
        {
          id: "ghost",
          fromId: "zhimai:self",
          toId: "person-2",
          label: "祖孙",
          basis: "推断依据：旧规则",
          evidenceMode: "inferred",
          derivedFromRelationIds: ["fact"],
          visibility: "hidden",
          recommendationPolicy: "block",
          createdAt: at,
        },
      ],
      lifeEvents: [],
      reminders: [],
    };

    const result = normalizeArchive(legacy);
    expect(result.sourceSchema).toBe("zhimai-connect/archive@1");
    expect(result.archive.records.relationAssertions).toHaveLength(1);
    expect(result.archive.records.relationAssertions[0]).toMatchObject({
      id: "fact",
      predicate: "parent_of",
      evidence: { sourceIds: [] },
    });
    expect(result.archive.projectionDiagnostics.derivedRelations).toMatchObject([{ id: "ghost" }]);
    expect(result.archive.records.relationViewPreferences).toHaveLength(2);
    expect(result.archive.records.referralPolicies).toHaveLength(2);
    expect(result.archive.records.collections).toMatchObject([{ name: "亲戚" }]);
    expect(result.archive.records.collectionMemberships).toHaveLength(1);
    expect(result.archive.records.persons[0].profile).not.toHaveProperty("circle");
    expect(result.archive.records.persons[0].entityRole).toBe("ego");
    expect(JSON.stringify(result.archive)).not.toContain("data:image");
    expect(result.warnings.join("\n")).toContain("不会写成事实");
    expect(result.warnings.join("\n")).toContain("不能恢复为证据链接");

    const plan = archiveRestorePlan(legacy);
    expect(plan.warnings.join("\n")).toContain("不会写成事实");
    expect(plan.records.relationAssertions.map((item) => item.id)).toEqual(["fact"]);
    expect(plan.discardedProjectionCount).toBe(1);
  });

  it("keeps projects@1 importable without pretending omitted modules existed", () => {
    const result = normalizeArchive({
      schema: "zhimai-connect/projects@1",
      exportedAt: "2026-08-28T10:00:00.000Z",
      persons: [{ id: "owner", name: "周宁", note: "", descriptors: [], thumb: "", createdAt: at }],
      projects: [
        {
          id: "project",
          title: "活动",
          ownerId: "owner",
          status: "planned",
          priority: "normal",
          createdAt: at,
        },
      ],
    });
    expect(result.archive.records.projects).toHaveLength(1);
    expect(result.archive.records.relationAssertions).toEqual([]);
    expect(result.warnings[0]).toContain("原文件中不存在");
  });

  it("rejects malformed JSON and unknown schemas with actionable errors", () => {
    expect(() => normalizeArchive("{oops")).toThrow(/有效 JSON/);
    expect(() => normalizeArchive({ schema: "zhimai-connect/archive@99" })).toThrow(
      /不支持的备份 schema/,
    );
  });
});
