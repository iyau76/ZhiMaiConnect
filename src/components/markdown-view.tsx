import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/** AI 回答的排版渲染：标题分级、列表、表格、事实/推测高亮 */
export function MarkdownView({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("space-y-3 text-[13px] leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="mt-5 border-b border-border pb-1.5 font-display text-lg tracking-tight first:mt-0">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h3 className="mt-5 border-b border-border pb-1.5 font-display text-base tracking-tight first:mt-0">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mt-4 text-sm font-semibold text-primary first:mt-0">{children}</h4>
          ),
          h4: ({ children }) => (
            <h5 className="mt-3 text-[13px] font-semibold first:mt-0">{children}</h5>
          ),
          p: ({ children }) => <p className="text-muted-foreground">{children}</p>,
          ul: ({ children }) => (
            <ul className="ml-1 space-y-1.5 border-l border-border pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-4 list-decimal space-y-1.5 marker:text-muted-foreground">{children}</ol>
          ),
          li: ({ children }) => <li className="text-muted-foreground">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
          hr: () => <hr className="my-4 border-border" />,
          blockquote: ({ children }) => (
            <blockquote className="rounded-r-lg border-l-2 border-primary bg-muted/40 py-2 pl-3 pr-2 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{children}</code>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted/50 px-3 py-2 font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border px-3 py-2 text-muted-foreground">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
