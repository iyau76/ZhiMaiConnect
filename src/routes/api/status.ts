import { createFileRoute } from "@tanstack/react-router";

import { apiJson, issueApiSession } from "../../lib/api-security.server";

export function handleStatusGet(request: Request) {
  const session = issueApiSession(request);
  return apiJson(
    {
      ok: true,
      sessionToken: session.token,
      customProxyHostsConfigured: Boolean(process.env.AI_PROXY_ALLOWED_HOSTS?.trim()),
    },
    { headers: { "Set-Cookie": session.cookie } },
  );
}

export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: ({ request }) => handleStatusGet(request),
    },
  },
});
