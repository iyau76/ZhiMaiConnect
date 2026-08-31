import { describe, expect, it } from "vitest";

import { detectActiveMedicalEmergency, routeAssistantRequest } from "./assistant-request-router";

describe("assistant immediate request router", () => {
  it("routes an active chest-pain emergency without model or archive work", () => {
    const route = routeAssistantRequest("家中老人持续胸痛并出冷汗，现在该怎么办？");

    expect(route?.kind).toBe("medical_emergency");
    expect(route?.answer.split("\n\n")[0]).toContain("120");
    expect(route?.answer).toContain("不要自行给药");
    expect(route?.answer).not.toMatch(/(?:片|粒|毫克|mg|毫升|ml)/iu);
  });

  it("does not intercept a non-urgent educational question", () => {
    expect(routeAssistantRequest("胸痛常见原因有哪些？")).toBeNull();
  });

  it.each([
    ["我爸胸口一直疼，还冒冷汗，怎么办", "chest"],
    ["他突然喘不过气了", "breathing"],
    ["他呼吸停止了", "breathing"],
    ["有人大出血", "bleeding"],
    ["血一直止不住", "bleeding"],
  ] as const)("recognises active emergency: %s", (question, signal) => {
    expect(detectActiveMedicalEmergency(question)).toBe(signal);
  });

  it.each([
    "小说中老人突然胸痛并出冷汗，这段怎么写？",
    "昨天家人突然胸痛出汗，现在已经好了，想了解原因",
    "剧本角色喘不过气时应该如何描写？",
  ])("does not intercept fictional or explicitly resolved context: %s", (question) => {
    expect(routeAssistantRequest(question)).toBeNull();
  });

  it("keeps routing when an older onset is explicitly still ongoing", () => {
    expect(routeAssistantRequest("昨天开始胸口疼，现在还在疼并冒冷汗")).not.toBeNull();
  });
});
