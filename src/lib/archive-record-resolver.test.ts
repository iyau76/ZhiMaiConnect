import { describe, expect, it } from "vitest";

import {
  resolveSemanticRecordRef,
  resolveSemanticRecordRefs,
  type ArchiveRecordResolverSnapshot,
} from "./archive-record-resolver";
import type {
  CollectionMembershipRecord,
  CollectionRecord,
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
} from "./face-db";
import { SELF_PERSON_ID } from "./person-identity";

function person(id: string, name: string, profile: PersonRecord["profile"] = {}): PersonRecord {
  return { id, name, note: "", descriptors: [], thumb: "", createdAt: 1, profile };
}

const persons = [
  person(SELF_PERSON_ID, "我"),
  person("zhang-design", "张伟", {
    org: "设计院",
    identities: [{ platform: "微信", alias: "阿伟" }],
  }),
  person("zhang-school", "张伟", { org: "学校" }),
  person("zhou", "周宁"),
];
const events: LifeEventRecord[] = [
  { id: "event-1", title: "校庆", date: "2026-09-02", personIds: ["zhang-design"], createdAt: 1 },
  { id: "event-2", title: "校庆", date: "2026-09-03", personIds: ["zhang-school"], createdAt: 1 },
];
const relations: RelationRecord[] = [
  { id: "relation-1", fromId: "zhang-design", toId: "zhou", label: "同事", createdAt: 1 },
  { id: "relation-2", fromId: "zhang-school", toId: "zhou", label: "同学", createdAt: 1 },
];
const collections: CollectionRecord[] = [
  { id: "circle-work", name: "同事", kind: "relationship_circle", createdAt: 1, updatedAt: 1 },
  { id: "context-work", name: "同事", kind: "context", createdAt: 1, updatedAt: 1 },
];
const collectionMemberships: CollectionMembershipRecord[] = [
  {
    id: "circle-work\0zhang-design",
    collectionId: "circle-work",
    personId: "zhang-design",
    source: "manual",
    createdAt: 1,
  },
];
const snapshot: ArchiveRecordResolverSnapshot = {
  persons,
  events,
  relations,
  collections,
  collectionMemberships,
  workspace: {
    people: [{ name: "林岚", _draftId: "draft:person:lin" }],
    events: [{ title: "见面", _draftId: "draft:event:meeting" }],
  },
};

describe("archive semantic record resolver", () => {
  it("uses optional hints to resolve same-name people and aliases", () => {
    expect(
      resolveSemanticRecordRef(
        { kind: "person", name: "张伟", hints: { org: "设计院" } },
        snapshot,
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "zhang-design" }] });
    expect(resolveSemanticRecordRef({ kind: "person", name: "阿伟" }, snapshot)).toMatchObject({
      status: "resolved",
      candidates: [{ id: "zhang-design" }],
    });
  });

  it("keeps ambiguous and missing refs isolated inside one batch", () => {
    const results = resolveSemanticRecordRefs(
      [
        { kind: "person", name: "张伟" },
        { kind: "person", name: "不存在" },
        { kind: "person", name: "周宁" },
      ],
      snapshot,
    );
    expect(results.map((result) => result.status)).toEqual(["ambiguous", "missing", "resolved"]);
  });

  it("resolves self and stable workspace recordRefs", () => {
    expect(resolveSemanticRecordRef({ kind: "self" }, snapshot)).toMatchObject({
      status: "resolved",
      candidates: [{ id: SELF_PERSON_ID }],
    });
    expect(
      resolveSemanticRecordRef(
        { kind: "workspace", domain: "event", recordRef: "draft:event:meeting" },
        snapshot,
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "draft:event:meeting" }] });
  });

  it("lets an update draft shadow the archive record it represents", () => {
    expect(
      resolveSemanticRecordRef(
        { kind: "person", name: "周宁" },
        {
          ...snapshot,
          workspace: {
            ...snapshot.workspace,
            people: [
              ...(snapshot.workspace?.people ?? []),
              { name: "周宁", _draftId: "draft:person:zhou", targetPersonId: "zhou" },
            ],
          },
        },
      ),
    ).toMatchObject({
      status: "resolved",
      candidates: [{ id: "draft:person:zhou", source: "workspace" }],
    });
  });

  it("uses a person ref to distinguish same-title workspace reminders", () => {
    const reminders: ReminderRecord[] = [];
    expect(
      resolveSemanticRecordRef(
        { kind: "reminder", title: "回电话", person: { kind: "person", name: "周宁" } },
        {
          ...snapshot,
          reminders,
          workspace: {
            ...snapshot.workspace,
            reminders: [
              {
                title: "回电话",
                people: ["周宁"],
                peoplePersonIds: ["zhou"],
                _draftId: "draft:reminder:zhou",
              },
              {
                title: "回电话",
                people: ["张伟"],
                peoplePersonIds: ["zhang-design"],
                _draftId: "draft:reminder:zhang",
              },
            ],
          },
        },
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "draft:reminder:zhou" }] });
  });

  it("uses endpoint candidates to resolve event, relation and collection selectors", () => {
    expect(
      resolveSemanticRecordRef(
        { kind: "event", title: "校庆", person: { kind: "person", name: "阿伟" } },
        snapshot,
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "event-1" }] });
    expect(
      resolveSemanticRecordRef(
        {
          kind: "relation",
          from: { kind: "person", name: "张伟" },
          to: { kind: "person", name: "周宁" },
          label: "同事",
        },
        snapshot,
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "relation-1" }] });
    expect(
      resolveSemanticRecordRef(
        { kind: "collection", name: "同事", collectionKind: "relationship_circle" },
        snapshot,
      ),
    ).toMatchObject({ status: "resolved", candidates: [{ id: "circle-work" }] });
  });

  it("resolves complete and collection-scoped person selections as sets", () => {
    expect(resolveSemanticRecordRef({ kind: "person_selection", scope: "all" }, snapshot)).toEqual(
      expect.objectContaining({
        status: "resolved",
        cardinality: "many",
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: "zhang-design" }),
          expect.objectContaining({ id: "zhang-school" }),
        ]),
      }),
    );
    expect(
      resolveSemanticRecordRef(
        {
          kind: "person_selection",
          scope: "collection",
          collection: {
            kind: "collection",
            name: "同事",
            collectionKind: "relationship_circle",
          },
        },
        snapshot,
      ),
    ).toMatchObject({
      status: "resolved",
      cardinality: "many",
      candidates: [{ id: "zhang-design" }],
    });
  });

  it("turns invalid refs into a missing result instead of throwing", () => {
    expect(
      resolveSemanticRecordRef({ kind: "person", personId: "hidden-id" }, snapshot),
    ).toMatchObject({
      status: "missing",
      candidates: [],
    });
  });
});
