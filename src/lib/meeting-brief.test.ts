import { describe, expect, it } from "vitest";

import type {
  LifeEventRecord,
  PersonRecord,
  RelationRecord,
  ReminderRecord,
  TaskRecord,
} from "./face-db";
import { mentionedArchivePeople } from "./connection-paths";
import { buildMeetingBrief, inspectMeetingBrief, type MeetingBriefInput } from "./meeting-brief";

const at = new Date("2026-09-05T08:00:00+08:00").getTime();

function person(id: string, name: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    descriptors: [],
    thumb: "",
    createdAt: at,
  };
}

function input() {
  const persons = [
    {
      ...person("tang", "唐悦"),
      profile: {
        relation: "大学同学",
        org: "九月校园记忆展",
        title: "活动摄影师",
        likes: ["胶片摄影", "咖啡"],
        metAt: "大学摄影社",
        identities: [{ platform: "微信", alias: "小唐" }],
      },
    },
    person("lin", "林柚"),
  ];
  const relations: RelationRecord[] = [
    {
      id: "relation-1",
      fromId: "tang",
      toId: "lin",
      label: "合作伙伴",
      createdAt: at,
      updatedAt: at,
      confirmationStatus: "confirmed",
      recordType: "assertion",
    },
  ];
  const events: LifeEventRecord[] = [
    {
      id: "event-1",
      date: "2026-08-20",
      precision: "day",
      title: "讨论校园记忆展",
      detail: "唐悦答应确认拍摄档期",
      personIds: ["tang"],
      createdAt: at,
    },
  ];
  const reminders: ReminderRecord[] = [
    {
      id: "reminder-1",
      title: "确认拍摄档期",
      due: "2026-09-08",
      personIds: ["tang"],
      done: false,
      createdAt: at,
    },
  ];
  const tasks: TaskRecord[] = [
    {
      id: "task-1",
      title: "准备展览需求清单",
      personIds: ["tang"],
      priority: "normal",
      status: "todo",
      createdAt: at,
    },
  ];
  return { persons, relations, events, reminders, tasks } satisfies MeetingBriefInput;
}

describe("meeting brief projection", () => {
  it("builds a saved snapshot with fact-level source references and separated suggestions", () => {
    const brief = buildMeetingBrief(input(), "tang", { id: "brief-1", now: at });

    expect(brief).toMatchObject({
      id: "brief-1",
      personId: "tang",
      personName: "唐悦",
      title: "见面前看看：唐悦",
      createdAt: at,
      updatedAt: at,
    });
    expect(brief.content.profile.map((item) => item.text)).toContain("和我的关系：大学同学");
    expect(brief.content.recentEvents[0].sources[0]).toMatchObject({
      kind: "event",
      id: "event-1",
    });
    expect(brief.content.openItems.map((item) => item.sources[0].kind).sort()).toEqual([
      "reminder",
      "task",
    ]);
    expect(brief.content.relatedPeople[0].text).toBe("林柚 · 合作伙伴（已确认关系）");
    expect(brief.content.relatedPeople[0].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "relation_assertion", id: "relation-1" }),
        expect.objectContaining({ kind: "person", id: "lin" }),
      ]),
    );
    expect(brief.content.talkingPoints[0].text).toContain("胶片摄影");
    expect(brief.sourceRefs.every((source) => source.revision.startsWith("r1:"))).toBe(true);
  });

  it("keeps the old snapshot and reports exactly which sources changed", () => {
    const originalInput = input();
    const brief = buildMeetingBrief(originalInput, "tang", { id: "brief-1", now: at });
    const changedInput = input();
    changedInput.persons[0] = {
      ...changedInput.persons[0],
      profile: { ...changedInput.persons[0].profile, title: "影像负责人" },
    };
    changedInput.events.push({
      id: "event-2",
      date: "2026-09-04",
      title: "确认布展时间",
      personIds: ["tang"],
      createdAt: at + 1,
    });

    const status = inspectMeetingBrief(brief, changedInput);

    expect(status.state).toBe("stale");
    expect(status.changes).toEqual(
      expect.arrayContaining([
        { kind: "person", id: "tang", change: "changed" },
        { kind: "event", id: "event-2", change: "added" },
      ]),
    );
    expect(brief.content.profile.some((item) => item.text.includes("活动摄影师"))).toBe(true);
    expect(brief.content.profile.some((item) => item.text.includes("影像负责人"))).toBe(false);

    const refreshed = buildMeetingBrief(changedInput, "tang", {
      previous: brief,
      now: at + 2,
    });
    expect(refreshed.id).not.toBe(brief.id);
    expect(refreshed.seriesId).toBe(brief.id);
    expect(refreshed.supersedesBriefId).toBe(brief.id);
    expect(refreshed.createdAt).toBe(at + 2);
    expect(refreshed.content.profile.some((item) => item.text.includes("影像负责人"))).toBe(true);
    expect(inspectMeetingBrief(refreshed, changedInput).state).toBe("current");
  });

  it("matches a person from a sentence or a saved alias without treating ambiguity as certainty", () => {
    const people = input().persons;
    expect(mentionedArchivePeople("明天要见唐悦", [...people]).map((item) => item.id)).toEqual([
      "tang",
    ]);
    expect(mentionedArchivePeople("约小唐喝咖啡", [...people]).map((item) => item.id)).toEqual([
      "tang",
    ]);

    const ambiguous = [...people, person("tang-2", "唐悦")];
    expect(mentionedArchivePeople("明天要见唐悦", ambiguous).map((item) => item.id)).toEqual([
      "tang",
      "tang-2",
    ]);
  });
});
