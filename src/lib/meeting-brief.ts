import {
  facesDb,
  type LifeEventRecord,
  type MeetingBriefLine,
  type MeetingBriefRecord,
  type MeetingBriefSourceKind,
  type MeetingBriefSourceRef,
  type PersonRecord,
  type RelationRecord,
  type ReminderRecord,
  type TaskRecord,
} from "./face-db";
import { archiveRecordRevision } from "./archive-mutation-plan";
import { eventSpan, formatEventTime } from "./fuzzy-date";

export interface MeetingBriefInput {
  persons: readonly PersonRecord[];
  relations: readonly RelationRecord[];
  events: readonly LifeEventRecord[];
  reminders: readonly ReminderRecord[];
  tasks: readonly TaskRecord[];
}

export interface MeetingBriefChange {
  kind: MeetingBriefSourceKind;
  id: string;
  change: "added" | "changed" | "removed";
}

export interface MeetingBriefStatus {
  state: "current" | "stale" | "person_deleted";
  changes: MeetingBriefChange[];
}

export async function loadMeetingBriefWorkspace() {
  const [persons, relations, events, reminders, tasks, briefs] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelations(),
    facesDb.listLifeEvents(),
    facesDb.listReminders(),
    facesDb.listTasks(),
    facesDb.listMeetingBriefs(),
  ]);
  return {
    input: { persons, relations, events, reminders, tasks } satisfies MeetingBriefInput,
    briefs,
  };
}

function sourceRef(
  kind: MeetingBriefSourceKind,
  id: string,
  record: unknown,
): MeetingBriefSourceRef {
  return { kind, id, revision: archiveRecordRevision(record) };
}

function personRef(person: PersonRecord) {
  const { descriptors: _descriptors, thumb: _thumb, photos: _photos, ...briefFields } = person;
  return sourceRef("person", person.id, briefFields);
}

function relationRef(relation: RelationRecord) {
  return sourceRef(
    relation.recordType === "derived" ? "relation_projection" : "relation_assertion",
    relation.id,
    relation,
  );
}

function eventRef(event: LifeEventRecord) {
  const { photos: _photos, ...briefFields } = event;
  return sourceRef("event", event.id, briefFields);
}

function line(text: string, ...sources: MeetingBriefSourceRef[]): MeetingBriefLine {
  return { text, sources };
}

function uniqueRefs(lines: readonly MeetingBriefLine[], person: PersonRecord) {
  const byKey = new Map<string, MeetingBriefSourceRef>();
  const own = personRef(person);
  byKey.set(`${own.kind}:${own.id}`, own);
  for (const item of lines) {
    for (const source of item.sources) byKey.set(`${source.kind}:${source.id}`, source);
  }
  return [...byKey.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function sourceRevision(refs: readonly MeetingBriefSourceRef[]) {
  return archiveRecordRevision(refs);
}

function relatedTo(personId: string, ids?: readonly string[]) {
  return Boolean(ids?.includes(personId));
}

function openItemOrder(left: ReminderRecord | TaskRecord, right: ReminderRecord | TaskRecord) {
  return (
    (left.due ?? "9999-99-99").localeCompare(right.due ?? "9999-99-99") ||
    right.createdAt - left.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function buildContent(input: MeetingBriefInput, person: PersonRecord, now: number) {
  const own = personRef(person);
  const profile: MeetingBriefLine[] = [];
  const personProfile = person.profile;
  const egoIds = new Set(
    input.persons
      .filter((item) => item.entityRole === "ego" || item.id === "zhimai:self")
      .map((item) => item.id),
  );
  const egoRelations = input.relations.filter(
    (relation) =>
      relation.confirmationStatus === "confirmed" &&
      ((relation.fromId === person.id && egoIds.has(relation.toId)) ||
        (relation.toId === person.id && egoIds.has(relation.fromId))),
  );
  for (const relation of egoRelations) {
    const from = input.persons.find((item) => item.id === relation.fromId)?.name ?? "我";
    const to = input.persons.find((item) => item.id === relation.toId)?.name ?? person.name;
    profile.push(line(`与我的关系：${from} → ${relation.label} → ${to}`, relationRef(relation)));
  }
  if (!egoRelations.length && personProfile?.relation?.trim())
    profile.push(line(`和我的关系：${personProfile.relation.trim()}`, own));
  const role = [personProfile?.org, personProfile?.department, personProfile?.title]
    .map((item) => item?.trim())
    .filter(Boolean)
    .join(" · ");
  if (role) profile.push(line(`身份：${role}`, own));
  if (personProfile?.metAt?.trim())
    profile.push(line(`相识于：${personProfile.metAt.trim()}`, own));
  if (personProfile?.contact?.trim())
    profile.push(line(`联系方式：${personProfile.contact.trim()}`, own));
  if (personProfile?.birthday?.trim())
    profile.push(line(`生日：${personProfile.birthday.trim()}`, own));
  if (personProfile?.likes?.length)
    profile.push(line(`偏好：${personProfile.likes.join("、")}`, own));
  if (personProfile?.dislikes?.length)
    profile.push(line(`留意：${personProfile.dislikes.join("、")}`, own));

  const clock = new Date(now);
  const today = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, "0")}-${String(clock.getDate()).padStart(2, "0")}`;
  const sharedEvents = input.events.filter((event) => relatedTo(person.id, event.personIds));
  const eventLine = (event: LifeEventRecord) =>
    line(
      `${formatEventTime(event)} · ${event.title}${event.detail?.trim() ? `：${event.detail.trim()}` : ""}`,
      eventRef(event),
    );
  const pastEvents = sharedEvents
    .filter((event) => eventSpan(event).end < today)
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt),
    )
    .slice(0, 5);
  const recentEvents = pastEvents.map(eventLine);
  const upcomingEvents = sharedEvents
    .filter((event) => eventSpan(event).end >= today)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 5)
    .map(eventLine);

  const reminders = input.reminders
    .filter((item) => !item.done && relatedTo(person.id, item.personIds))
    .map((item) => ({ kind: "reminder" as const, item }));
  const tasks = input.tasks
    .filter((item) => item.status !== "done" && relatedTo(person.id, item.personIds))
    .map((item) => ({ kind: "task" as const, item }));
  const openItems = [
    ...upcomingEvents,
    ...[...reminders, ...tasks]
      .sort((left, right) => openItemOrder(left.item, right.item))
      .slice(0, 8)
      .map(({ kind, item }) =>
        line(
          `${item.due ? `${item.due} · ` : ""}${item.title}${item.detail?.trim() ? `：${item.detail.trim()}` : ""}`,
          sourceRef(kind, item.id, item),
        ),
      ),
  ];

  const personsById = new Map(input.persons.map((item) => [item.id, item]));
  const relatedPeople = input.relations
    .filter(
      (relation) =>
        relation.confirmationStatus === "confirmed" &&
        (relation.fromId === person.id || relation.toId === person.id),
    )
    .sort(
      (left, right) =>
        Number(left.recordType === "derived") - Number(right.recordType === "derived") ||
        (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt),
    )
    .slice(0, 8)
    .flatMap((relation) => {
      const otherId = relation.fromId === person.id ? relation.toId : relation.fromId;
      const other = personsById.get(otherId);
      if (!other) return [];
      const qualifier = relation.recordType === "derived" ? "推导关系" : "已确认关系";
      return [
        line(
          `${other.name} · ${relation.label}（${qualifier}）`,
          relationRef(relation),
          personRef(other),
        ),
      ];
    });

  const talkingPoints: MeetingBriefLine[] = [];
  if (personProfile?.likes?.length) {
    talkingPoints.push(line(`可以从“${personProfile.likes.slice(0, 2).join("、")}”聊起。`, own));
  }
  if (personProfile?.projects?.length) {
    talkingPoints.push(line(`可以问问“${personProfile.projects[0]}”最近的进展。`, own));
  }
  if (pastEvents[0]) {
    talkingPoints.push(
      line(`可以接着上次的“${pastEvents[0].title}”聊聊。`, ...recentEvents[0].sources),
    );
  }

  const gaps: string[] = [];
  if (!egoRelations.length && !personProfile?.relation?.trim()) gaps.push("还没记录和我的关系");
  if (!personProfile?.contact?.trim()) gaps.push("还没记录联系方式");
  if (!personProfile?.birthday?.trim()) gaps.push("还没记录生日");
  if (!personProfile?.metAt?.trim()) gaps.push("还没记录相识场景");
  if (!sharedEvents.length) gaps.push("还没有共同事件");

  return { profile, recentEvents, openItems, relatedPeople, talkingPoints, gaps };
}

export function buildMeetingBrief(
  input: MeetingBriefInput,
  personId: string,
  options: { id?: string; now?: number; previous?: MeetingBriefRecord } = {},
): MeetingBriefRecord {
  const person = input.persons.find((item) => item.id === personId);
  if (!person) throw new Error("找不到要见的人");
  const now = options.now ?? Date.now();
  const content = buildContent(input, person, now);
  const allLines = [
    ...content.profile,
    ...content.recentEvents,
    ...content.openItems,
    ...content.relatedPeople,
    ...content.talkingPoints,
  ];
  const sourceRefs = uniqueRefs(allLines, person);
  const previous = options.previous;
  const id = options.id ?? crypto.randomUUID();
  return {
    id,
    seriesId: previous?.seriesId ?? previous?.id ?? id,
    supersedesBriefId: previous?.id,
    personId: person.id,
    personName: person.name,
    title: `见面前看看：${person.name}`,
    sourceRevision: sourceRevision(sourceRefs),
    sourceRefs,
    content,
    createdAt: now,
    updatedAt: now,
  };
}

export function inspectMeetingBrief(
  brief: MeetingBriefRecord,
  input: MeetingBriefInput,
): MeetingBriefStatus {
  if (!input.persons.some((person) => person.id === brief.personId)) {
    return { state: "person_deleted", changes: [] };
  }
  const current = buildMeetingBrief(input, brief.personId, { id: brief.id, now: brief.updatedAt });
  const savedByKey = new Map(brief.sourceRefs.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  const currentByKey = new Map(current.sourceRefs.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
  const changes: MeetingBriefChange[] = [];
  for (const [key, ref] of currentByKey) {
    const saved = savedByKey.get(key);
    if (!saved) changes.push({ kind: ref.kind, id: ref.id, change: "added" });
    else if (saved.revision !== ref.revision)
      changes.push({ kind: ref.kind, id: ref.id, change: "changed" });
  }
  for (const [key, ref] of savedByKey) {
    if (!currentByKey.has(key)) changes.push({ kind: ref.kind, id: ref.id, change: "removed" });
  }
  return {
    state: changes.length || current.sourceRevision !== brief.sourceRevision ? "stale" : "current",
    changes,
  };
}
