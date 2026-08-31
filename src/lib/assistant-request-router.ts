export interface AssistantImmediateRoute {
  kind: "medical_emergency";
  answer: string;
}

function compact(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{Z}\p{Cf}\s]+/gu, "");
}

function isNonRealScenario(value: string) {
  return /(?:小说|剧本|故事|作文|创作|写作|角色|游戏剧情|影视桥段|这段怎么写|如何描写|怎么描写|翻译这段|测试用例|单元测试|模拟案例)/u.test(
    value,
  );
}

function isExplicitlyResolved(value: string) {
  return /(?:现在|目前|后来|之后)?(?:已经|已)(?:好了|缓解|恢复|没事|正常)|(?:症状|疼痛|出血)(?:已经|已)(?:消失|停止|缓解)/u.test(
    value,
  );
}

function hasOngoingOverride(value: string) {
  return /(?:现在|目前|此刻|正在|仍然|仍在|还在|一直|持续|又|再次).{0,12}(?:胸痛|胸疼|胸口疼|胸闷|冷汗|冒汗|呼吸困难|喘不过气|不能呼吸|没有呼吸|出血|流血|止不住)/u.test(
    value,
  );
}

export type MedicalEmergencySignal = "chest" | "breathing" | "bleeding";

export function detectActiveMedicalEmergency(question: string): MedicalEmergencySignal | null {
  const value = compact(question);
  if (isNonRealScenario(value)) return null;
  if (isExplicitlyResolved(value) && !hasOngoingOverride(value)) return null;

  const chestPain = /(?:胸痛|胸疼|胸闷|心口疼|压榨感|胸口.{0,8}(?:疼|痛|闷|压迫))/u.test(value);
  const chestCompanion = /(?:冷汗|冒冷汗|冒汗|出汗|呼吸困难|喘不过气|晕厥|昏厥)/u.test(value);
  if (chestPain && chestCompanion) return "chest";

  if (
    /(?:喘不过气|上不来气|呼吸困难|无法呼吸|不能呼吸|没有呼吸|没呼吸|呼吸停止|停止呼吸|呼吸停了|窒息)/u.test(
      value,
    )
  ) {
    return "breathing";
  }

  if (
    /(?:大出血|严重出血|大量出血|喷射性出血|血(?:一直|持续)?止不住|流血不止|出血不止)/u.test(value)
  ) {
    return "bleeding";
  }
  return null;
}

/**
 * High-urgency routing happens before model or tool access. It is intentionally
 * narrow: only combinations that should never wait for an Agent round match.
 */
export function routeAssistantRequest(question: string): AssistantImmediateRoute | null {
  if (!detectActiveMedicalEmergency(question)) return null;

  return {
    kind: "medical_emergency",
    answer: [
      "这是可能危及生命的紧急情况。若在中国大陆，请立即拨打 120；其他地区请立即拨打当地急救电话。不要等待 AI、联网检索或档案联系人回复，也不要自行驾车送医。",
      "让患者立即停止活动并保持安全、安静，按急救调度员的指示调整体位和观察呼吸。不要自行给药、进食或饮水。准备说明症状开始时间、当前意识和呼吸情况，并备好既往病史、用药清单与过敏史。",
      "如果患者失去意识或没有正常呼吸，请立即把这一情况告诉急救调度员，并在其指导下开始心肺复苏；附近有 AED 时按设备语音提示操作。以上只用于争取急救时间，不能替代现场急救人员和医生。",
    ].join("\n\n"),
  };
}
