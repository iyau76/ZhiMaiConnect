import { isFreeTierPreset, isCloudProvider, type ProviderPreset } from "./vision-providers";

export type CloudDataType = "文字内容" | "人物关系上下文" | "图片" | "音频";

const CONSENT_KEY = "openglass.cloud-transfer-consents";

const FREE_TIER_RECIPIENT = "知脉免费体验（经我们的中转服务器转给免费模型）";
const FREE_TIER_NOTE =
  "这是官方提供的免费额度：请求会先经过知脉的体验服务器，再由它转发给模型服务商。服务器只转发，不保存内容。额度有限、可能排队，需要更稳定的服务可以换成自己的模型。";

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

function providerName(preset: ProviderPreset) {
  if (isFreeTierPreset(preset)) return FREE_TIER_RECIPIENT;
  return preset.name || "云模型";
}

function showCloudTransferConsent(provider: string, dataTypes: CloudDataType[], freeTier: boolean) {
  if (typeof document === "undefined" || !document.body) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const lines = [
        `接收方：${provider}`,
        "",
        `本次发送：${dataTypes.join("、")}`,
        ...(freeTier ? ["", FREE_TIER_NOTE] : []),
        "",
        "是否继续？",
      ];
      return Promise.resolve(window.confirm(lines.join("\n")));
    }
    throw new Error("云模型调用只能在浏览器中经用户确认后进行");
  }

  return new Promise<boolean>((resolve) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.dataset.testid = "cloud-transfer-consent";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "cloud-transfer-consent-title");
    overlay.className =
      "fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm";

    const card = document.createElement("section");
    card.className =
      "w-[min(92vw,480px)] rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-2xl";
    card.innerHTML = `
      <div class="mb-5 flex items-start gap-3">
        <div class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary" aria-hidden="true">↗</div>
        <div>
          <h2 id="cloud-transfer-consent-title" class="text-lg font-semibold">发送给云模型</h2>
          <p class="mt-1 text-sm text-muted-foreground">本次确认仅用于当前浏览器会话。</p>
        </div>
      </div>
      <dl class="space-y-3 rounded-xl border border-border bg-background/60 p-4 text-sm">
        <div class="grid grid-cols-[5rem_1fr] gap-3">
          <dt class="text-muted-foreground">接收方</dt>
          <dd class="font-medium" data-cloud-consent-provider></dd>
        </div>
        <div class="grid grid-cols-[5rem_1fr] gap-3">
          <dt class="text-muted-foreground">本次发送</dt>
          <dd class="font-medium" data-cloud-consent-types></dd>
        </div>
      </dl>
      ${
        freeTier
          ? `<p data-cloud-consent-note class="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted-foreground">${FREE_TIER_NOTE}</p>`
          : ""
      }
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        ${
          freeTier
            ? `<button type="button" data-cloud-consent-configure class="mr-auto rounded-lg border border-primary/50 px-4 py-2 text-sm text-primary hover:bg-primary/10">去配置自己的模型</button>`
            : ""
        }
        <button type="button" data-cloud-consent-cancel class="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">取消</button>
        <button type="button" data-cloud-consent-continue class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">继续</button>
      </div>
    `;
    card.querySelector<HTMLElement>("[data-cloud-consent-provider]")!.textContent = provider;
    card.querySelector<HTMLElement>("[data-cloud-consent-types]")!.textContent =
      dataTypes.join("、");
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cancel = card.querySelector<HTMLButtonElement>("[data-cloud-consent-cancel]")!;
    const proceed = card.querySelector<HTMLButtonElement>("[data-cloud-consent-continue]")!;
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      previousFocus?.focus();
      resolve(accepted);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const configure = card.querySelector<HTMLButtonElement>("[data-cloud-consent-configure]");
    configure?.addEventListener("click", () => {
      finish(false);
      window.location.assign("?view=models");
    });
    cancel.addEventListener("click", () => finish(false));
    proceed.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    proceed.focus();
  });
}

/**
 * 云模型在当前会话第一次接收某类数据前，明确告知服务商和数据类型。
 * 本机直连的推理服务不经过此确认；新增数据类型时会再次确认。
 */
export async function confirmCloudTransfer(preset: ProviderPreset, dataTypes: CloudDataType[]) {
  if (!isCloudProvider(preset)) return;

  const types = [...new Set(dataTypes)];
  const id = consentId(preset.id, types);
  const accepted = readConsents();
  if (accepted.has(id)) return;

  const confirmed = await showCloudTransferConsent(
    providerName(preset),
    types,
    isFreeTierPreset(preset),
  );
  if (!confirmed) throw new Error("已取消向云模型发送数据");

  accepted.add(id);
  sessionStorage.setItem(CONSENT_KEY, JSON.stringify([...accepted]));
}

export function clearCloudTransferConsents() {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(CONSENT_KEY);
}
