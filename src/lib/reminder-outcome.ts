import type { LifeEventRecord, ReminderRecord } from "./face-db";
import { makeSource } from "./provenance";
import { todayStr } from "./personal";

export function buildReminderOutcome(
  reminder: ReminderRecord,
  text: string,
  options: {
    eventId: string;
    now?: Date;
    previous?: LifeEventRecord;
  },
) {
  const raw = text.trim().replace(/\r/g, "");
  if (!raw) throw new Error("请先写下这件事最后怎么样了");
  const [head, ...rest] = raw.split("\n");
  const previous = options.previous;
  const timestamp = (options.now ?? new Date()).getTime();
  const event: LifeEventRecord = {
    id: previous?.id ?? options.eventId,
    date: todayStr(options.now),
    precision: "day",
    title: (head || raw).slice(0, 60),
    detail: rest.join("\n").trim() || undefined,
    personIds: [...(reminder.personIds ?? [])],
    kind: "互动结果",
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: previous ? timestamp : undefined,
    source: makeSource("manual", "完成提醒后补记"),
  };
  return {
    event,
    reminder: { ...reminder, done: true, completionEventId: event.id },
  };
}
