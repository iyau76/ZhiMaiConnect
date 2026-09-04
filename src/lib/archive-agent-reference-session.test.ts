import { describe, expect, it } from "vitest";

import { ArchiveAgentReferenceSession } from "./archive-agent-reference-session";
import type { ArchiveRecordResolverSnapshot } from "./archive-record-resolver";
import type { PersonRecord } from "./face-db";

function person(id: string, name: string, org?: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    profile: org ? { org } : undefined,
    descriptors: [],
    thumb: "",
    createdAt: 1,
  };
}

const stableIds = {
  design: "28f269db-2747-44a5-a186-person-design",
  school: "5e4db2ed-afab-40e3-8a7f-person-school",
  zhou: "59144bdc-f449-46dc-a6d4-person-zhou",
  event: "c90e996b-359e-4c5d-bb47-event-campus",
  relation: "eeaa102d-9732-40b2-a6a7-relation-colleague",
  circle: "11813be4-2a2f-43ef-a033-circle-work",
};

const snapshot: ArchiveRecordResolverSnapshot = {
  persons: [
    person(stableIds.design, "张伟", "设计院"),
    person(stableIds.school, "张伟", "学校"),
    person(stableIds.zhou, "周宁"),
  ],
  events: [
    {
      id: stableIds.event,
      title: "校庆",
      date: "2026-09-02",
      personIds: [stableIds.design],
      createdAt: 1,
    },
  ],
  relations: [
    {
      id: stableIds.relation,
      fromId: stableIds.design,
      toId: stableIds.zhou,
      label: "同事",
      createdAt: 1,
    },
  ],
  collections: [
    {
      id: stableIds.circle,
      name: "同事",
      kind: "relationship_circle",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  workspace: {
    people: [{ name: "林岚", _draftId: "draft:person:lin" }],
    facts: [{ person: "林岚", key: "专长", value: "插画", _draftId: "draft:fact:lin-skill" }],
  },
};

function resolvedHandle(session: ArchiveAgentReferenceSession, ref: unknown) {
  const result = session.resolve(ref);
  if (result.status !== "resolved" || result.cardinality !== "one") {
    throw new Error("测试引用没有唯一解析");
  }
  return result.candidates[0].handle;
}

describe("ArchiveAgentReferenceSession", () => {
  it("returns model-visible opaque handles and restores stable IDs only locally", () => {
    const session = new ArchiveAgentReferenceSession(snapshot, "run-alpha");
    const resolution = session.resolve({
      kind: "person",
      name: "张伟",
      hints: { org: "设计院" },
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      cardinality: "one",
      candidates: [{ label: "张伟", domain: "person" }],
    });
    const serialized = JSON.stringify(resolution);
    Object.values(stableIds).forEach((stableId) => expect(serialized).not.toContain(stableId));
    if (resolution.status !== "resolved") throw new Error("人物应当唯一解析");
    const handle = resolution.candidates[0].handle;
    expect(handle).toMatch(/^ref_[0-9a-f]{32}$/);
    expect(handle).not.toContain("person-design");
    expect(session.restoreHandle(handle, "person")).toEqual({
      status: "resolved",
      domain: "person",
      stableId: stableIds.design,
    });
  });

  it("keeps one record stable inside a run and separates different runs", () => {
    const first = new ArchiveAgentReferenceSession(snapshot, "run-alpha");
    const sameRun = ArchiveAgentReferenceSession.restore(snapshot, first.serialize());
    const otherRun = new ArchiveAgentReferenceSession(snapshot, "run-beta");
    const ref = { kind: "event", title: "校庆", date: "2026-09-02" };

    const firstHandle = resolvedHandle(first, ref);
    expect(resolvedHandle(sameRun, ref)).toBe(firstHandle);
    expect(resolvedHandle(otherRun, ref)).not.toBe(firstHandle);
    expect(JSON.parse(JSON.stringify(first.serialize()))).toEqual({
      version: 1,
      namespace: "run-alpha",
    });
  });

  it("is independent of snapshot array order", () => {
    const reordered: ArchiveRecordResolverSnapshot = {
      ...snapshot,
      persons: [...snapshot.persons].reverse(),
      events: [...snapshot.events].reverse(),
      relations: [...snapshot.relations].reverse(),
      collections: [...snapshot.collections].reverse(),
    };
    const first = new ArchiveAgentReferenceSession(snapshot, "run-reorder");
    const second = new ArchiveAgentReferenceSession(reordered, "run-reorder");
    const ref = { kind: "person", name: "张伟", hints: { org: "学校" } };

    const firstHandle = resolvedHandle(first, ref);
    const secondHandle = resolvedHandle(second, ref);
    expect(secondHandle).toBe(firstHandle);
    expect(second.restoreHandle(secondHandle, "person")).toMatchObject({
      status: "resolved",
      stableId: stableIds.school,
    });
  });

  it("isolates ambiguous, missing and resolved semantic references item by item", () => {
    const session = new ArchiveAgentReferenceSession(snapshot, "run-batch");
    const results = session.resolveMany([
      { kind: "person", name: "张伟" },
      { kind: "person", name: "不存在" },
      { kind: "person", name: "周宁" },
    ]);

    expect(results.map((result) => result.status)).toEqual(["ambiguous", "missing", "resolved"]);
    expect(results[0]).toMatchObject({
      status: "ambiguous",
      candidates: [{ label: "张伟" }, { label: "张伟" }],
    });
    const visibleBatch = JSON.stringify(results);
    Object.values(stableIds).forEach((stableId) => expect(visibleBatch).not.toContain(stableId));
  });

  it("rejects unknown handles and cross-domain use without exposing a stable ID", () => {
    const session = new ArchiveAgentReferenceSession(snapshot, "run-domain");
    const eventHandle = resolvedHandle(session, { kind: "event", title: "校庆" });

    expect(session.restoreHandle(eventHandle, "person")).toEqual({
      status: "domain_mismatch",
      actualDomain: "event",
      reason: "引用属于 event，不能作为 person 使用",
    });
    expect(session.restoreHandle("ref_00000000000000000000000000000000", "event")).toEqual({
      status: "missing",
      reason: "当前运行中不存在该引用",
    });
  });

  it("supports archive and workspace records through the same handle boundary", () => {
    const session = new ArchiveAgentReferenceSession(snapshot, "run-workspace");
    const workspaceHandle = resolvedHandle(session, {
      kind: "workspace",
      domain: "fact",
      recordRef: "draft:fact:lin-skill",
    });
    const circleHandle = resolvedHandle(session, {
      kind: "collection",
      name: "同事",
      collectionKind: "relationship_circle",
    });

    expect(session.restoreHandle(workspaceHandle, "fact")).toMatchObject({
      status: "resolved",
      stableId: "draft:fact:lin-skill",
    });
    expect(session.restoreHandle(circleHandle, "collection")).toMatchObject({
      status: "resolved",
      stableId: stableIds.circle,
    });
  });
});
