import type { ProviderPreset } from "./vision-providers";

export type CloudDataType = "文字内容" | "人物关系上下文" | "图片" | "音频";

const CONSENT_KEY = "openglass.cloud-transfer-consents";

function consentId(providerId: string, dataTypes: CloudDataType[]) {
  return `${providerId}:${[...new Set(dataTypes)].sort().join("|")}`;
}

function readConsents(): Set<string> {
  if (typeof sessionStorage === "undefined") return new Set();
  try {
    const value = JSON.parse(sessionStorage.getItem(CONSENT_KEY) ?? "[]") as unknown;
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function providerName(preset: ProviderPreset | undefined) {
  if (!preset || preset.kind === "lovable") return "Lovable AI";
  return preset.name || "自定义云模型";
}

/**
 * 云模型在当前会话第一次接收某类数据前，明确告知服务商和数据类型。
 * 本地 Ollama 不经过此确认；新增数据类型时会再次确认。
 */
export function confirmCloudTransfer(
  preset: ProviderPreset | undefined,
  dataTypes: CloudDataType[],
) {
  if (preset?.kind === "ollama") return;
  if (typeof window === "undefined" || typeof window.confirm !== "function") {
    throw new Error("云模型调用只能在浏览器中经用户确认后进行");
  }

  const types = [...new Set(dataTypes)];
  const id = consentId(preset?.id ?? "lovable-transcription", types);
  const accepted = readConsents();
  if (accepted.has(id)) return;

  const confirmed = window.confirm(
    [
      `即将把本次任务所需的${types.join("、")}发送给 ${providerName(preset)}。`,
      "本地人物档案不会被整库上传；模型结果可能出错，请在写入或发送前复核。",
      "是否继续？",
    ].join("\n\n"),
  );
  if (!confirmed) throw new Error("已取消向云模型发送数据");

  accepted.add(id);
  sessionStorage.setItem(CONSENT_KEY, JSON.stringify([...accepted]));
}

export function clearCloudTransferConsents() {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(CONSENT_KEY);
}
