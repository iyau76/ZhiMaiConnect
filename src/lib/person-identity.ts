export const SELF_PERSON_ID = "zhimai:self";

export function isSelfReference(value: string) {
  const normalized = value.trim().toLocaleLowerCase("zh-CN");
  return normalized === "我" || normalized === "me" || normalized === SELF_PERSON_ID;
}
