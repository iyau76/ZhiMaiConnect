import type { PersonRecord, RelationRecord } from "./face-db";
import {
  applyPersonUpdateProposal,
  createPersonUpdateProposal,
  personUpdateDiff,
  type PersonUpdateProposal,
} from "./person-update-tool";
import {
  applyRelationUpdateProposal,
  createRelationUpdateProposal,
  relationUpdateDiff,
  type RelationUpdateProposal,
} from "./relation-update-tool";

export type ArchiveUpdateProposal = PersonUpdateProposal | RelationUpdateProposal;

export function createArchiveUpdateProposal(
  tool: string,
  args: unknown,
  archive: { persons: PersonRecord[]; relations: RelationRecord[] },
): ArchiveUpdateProposal {
  if (tool === "update_person") return createPersonUpdateProposal(args, archive.persons);
  if (tool === "update_relation") {
    return createRelationUpdateProposal(args, archive.relations, archive.persons);
  }
  throw new Error("不支持的档案修改工具");
}

export function archiveUpdateDiff(
  proposal: ArchiveUpdateProposal,
  archive: { persons: PersonRecord[]; relations: RelationRecord[] },
) {
  if (proposal.tool === "update_person") {
    const person = archive.persons.find((item) => item.id === proposal.personId);
    return person ? personUpdateDiff(proposal, person) : [];
  }
  const relation = archive.relations.find((item) => item.id === proposal.relationId);
  return relation ? relationUpdateDiff(proposal, relation) : [];
}

export function applyArchiveUpdateProposal(proposal: ArchiveUpdateProposal) {
  return proposal.tool === "update_person"
    ? applyPersonUpdateProposal(proposal)
    : applyRelationUpdateProposal(proposal);
}
