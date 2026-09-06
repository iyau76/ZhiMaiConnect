import { createFileRoute } from "@tanstack/react-router";
import { Workspace } from "@/components/workspace";
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        name: "description",
        content: "本地优先记录人物、事件与关系；云端 AI 仅在确认后接收当前任务所需内容。",
      },
      { property: "og:title", content: "知脉 Connect · 个人人脉与人情往来助手" },
      {
        property: "og:description",
        content: "本地优先、证据可追溯的人际关系记忆与行动助手。",
      },

      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Workspace,
});
