import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";

type Status = { lovableConfigured?: boolean };

export function StartupConfigNotice() {
  const [missingLovableKey, setMissingLovableKey] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/status", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const status = (await response.json()) as Status;
        setMissingLovableKey(status.lovableConfigured !== true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!missingLovableKey) return null;
  return (
    <div
      role="status"
      className="mb-5 flex max-w-3xl items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-400/10 p-3 text-xs text-amber-800 dark:text-amber-200"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {t(
          "服务端未配置 LOVABLE_API_KEY：本地资料、关系图、日期提醒和候选排序仍可使用；AI 功能可改用本机 Ollama 或获准的自定义接口。",
        )}
      </span>
    </div>
  );
}
