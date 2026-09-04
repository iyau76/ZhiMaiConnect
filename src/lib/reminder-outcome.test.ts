import { describe, expect, it } from "vitest";

import type { ReminderRecord } from "./face-db";
import { buildReminderOutcome } from "./reminder-outcome";

describe("reminder outcome", () => {
  it("turns an optional completion note into a stable linked event", () => {
    const reminder: ReminderRecord = {
      id: "reminder-1",
      title: "把拍摄清单发给唐悦",
      personIds: ["person-tang"],
      done: false,
      createdAt: 1,
    };

    const result = buildReminderOutcome(reminder, "已经发出清单\n唐悦说明天确认", {
      eventId: "event-result",
      now: new Date("2026-09-05T12:00:00+08:00"),
    });

    expect(result.event).toMatchObject({
      id: "event-result",
      date: "2026-09-05",
      title: "已经发出清单",
      detail: "唐悦说明天确认",
      personIds: ["person-tang"],
      kind: "互动结果",
    });
    expect(result.reminder).toMatchObject({ done: true, completionEventId: "event-result" });
  });
});
