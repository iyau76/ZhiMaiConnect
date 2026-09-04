import { describe, expect, it } from "vitest";

import { ensureIntakeWorkspace, intakeWorkspaceView } from "./intake-workspace";

describe("intake workspace identities", () => {
  it("rebases one-run plan references into stable draft references", () => {
    const workspace = ensureIntakeWorkspace({
      _revision: 1,
      people: [{ name: "唐悦", _draftId: "plan:person-tang" }],
      facts: [
        {
          person: "唐悦",
          key: "身份",
          value: "摄影社搭档",
          _draftId: "plan:fact-role",
          personDraftId: "plan:person-tang",
        },
      ],
      events: [
        {
          title: "讨论展览",
          people: ["唐悦"],
          peopleDraftIds: ["plan:person-tang"],
          _draftId: "plan:event-exhibition",
        },
      ],
      _groundingWarnings: [
        {
          personIndex: 0,
          personDraftId: "plan:person-tang",
          personName: "唐悦",
          field: "closeness",
          rejectedValue: "5",
        },
      ],
    });

    const personRef = workspace.people?.[0]._draftId;
    expect(personRef).toMatch(/^draft:person:/);
    expect(workspace.facts?.[0]).toMatchObject({
      personDraftId: personRef,
      _draftId: expect.stringMatching(/^draft:fact:/),
    });
    expect(workspace.events?.[0]).toMatchObject({
      peopleDraftIds: [personRef],
      _draftId: expect.stringMatching(/^draft:event:/),
    });
    expect(workspace._groundingWarnings?.[0].personDraftId).toBe(personRef);
  });

  it("exposes recordRef without leaking internal metadata", () => {
    const view = intakeWorkspaceView({
      people: [
        {
          name: "唐悦",
          _draftId: "draft:person:tang",
          _identityChecked: true,
          _identityReason: "本地身份解析",
        },
      ],
      relations: [
        {
          from: "唐悦",
          to: "周宁",
          label: "同事",
          _draftId: "draft:relation:peer",
          _relationChecked: true,
          _relationReason: "本地关系核对",
        },
      ],
      events: [
        {
          title: "讨论展览",
          _draftId: "draft:event:review",
          _eventChecked: true,
          _eventReason: "本地事件核对",
          _groundingVerified: true,
        },
      ],
    });
    expect(view.people[0]).toMatchObject({ recordRef: "draft:person:tang", name: "唐悦" });
    expect(JSON.stringify(view)).not.toMatch(/_(?:draft|identity|relation|event|grounding)/u);
  });

  it("keeps archive identifiers out of the model-facing workspace view", () => {
    const view = intakeWorkspaceView({
      people: [{ name: "Alex", targetPersonId: "person-uuid" }],
      facts: [{ person: "Alex", key: "role", value: "designer", personId: "person-uuid" }],
      relations: [
        {
          from: "Alex",
          to: "Blair",
          label: "colleague",
          targetRelationId: "relation-uuid",
          fromPersonId: "person-uuid",
          toPersonId: "other-person-uuid",
        },
      ],
      events: [
        {
          title: "Review",
          people: ["Alex"],
          targetEventId: "event-uuid",
          peoplePersonIds: ["person-uuid"],
        },
      ],
      reminders: [
        {
          title: "Follow up",
          people: ["Alex"],
          peoplePersonIds: ["person-uuid"],
        },
      ],
    });

    expect(JSON.stringify(view)).not.toContain("person-uuid");
    expect(JSON.stringify(view)).not.toContain("other-person-uuid");
    expect(JSON.stringify(view)).not.toContain("relation-uuid");
    expect(JSON.stringify(view)).not.toContain("event-uuid");
  });
});
