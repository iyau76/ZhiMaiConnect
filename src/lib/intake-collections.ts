import { collectionMembershipId } from "./archive-mutation-plan";
import type {
  ArchiveMutationWriteBatch,
  CollectionRecord,
  CollectionMembershipRecord,
} from "./face-db";
import type { IngestCollection } from "./intake-draft";

export type IntakeCollectionUndo = Pick<
  ArchiveMutationWriteBatch,
  "collections" | "collectionMemberships" | "deleteCollectionIds" | "deleteCollectionMembershipIds"
>;

/** Resolve temporary people only after the user has chosen new/existing identities. */
export function compileIntakeCollections(input: {
  drafts: readonly IngestCollection[];
  collections: readonly CollectionRecord[];
  memberships: readonly CollectionMembershipRecord[];
  resolvePerson: (member: IngestCollection["memberships"][number]) => string | undefined;
  now: number;
}) {
  const forward: IntakeCollectionUndo = {
    collections: [],
    collectionMemberships: [],
    deleteCollectionMembershipIds: [],
  };
  const undo: IntakeCollectionUndo = {
    collections: [],
    collectionMemberships: [],
    deleteCollectionIds: [],
    deleteCollectionMembershipIds: [],
  };
  for (const draft of input.drafts) {
    if (!draft.name.trim()) throw new Error("请填写圈层名称");
    const previous = input.collections.find((row) => row.id === draft.targetCollectionId);
    const collection: CollectionRecord = {
      id: draft.targetCollectionId,
      name: draft.name.trim(),
      kind: draft.kind,
      color: draft.color,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    forward.collections!.push(collection);
    if (previous) undo.collections!.push(previous);
    else undo.deleteCollectionIds!.push(collection.id);
    const decisions = new Map<string, "add" | "remove">();
    for (const member of draft.memberships) {
      const personId = input.resolvePerson(member);
      if (!personId) throw new Error(`请先确认圈层“${draft.name}”中的人物：${member.person}`);
      decisions.set(personId, member.action);
    }
    for (const [personId, action] of decisions) {
      const previousMember = input.memberships.find(
        (row) => row.collectionId === collection.id && row.personId === personId,
      );
      if (action === "remove") {
        if (previousMember) {
          forward.deleteCollectionMembershipIds!.push(previousMember.id);
          undo.collectionMemberships!.push(previousMember);
        }
      } else if (!previousMember) {
        const id = collectionMembershipId(collection.id, personId);
        forward.collectionMemberships!.push({
          id,
          collectionId: collection.id,
          personId,
          source: "ai_approved",
          createdAt: input.now,
        });
        undo.deleteCollectionMembershipIds!.push(id);
      }
    }
  }
  return { forward, undo };
}
