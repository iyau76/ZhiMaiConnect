/** 把人物关系库和事务导出成 Markdown / Word / PDF（浏览器本地生成，不上传） */

import { facesDb, type PersonRecord, type ProjectRecord, type RelationRecord } from "./face-db";

export type ExportFormat = "md" | "docx" | "pdf";
export type ExportScope = "people" | "projects";

const STATUS_LABEL: Record<ProjectRecord["status"], string> = {
  planned: "待启动",
  active: "进行中",
  blocked: "受阻",
  done: "已完成",
};

const PRIORITY_LABEL: Record<ProjectRecord["priority"], string> = {
  high: "高",
  normal: "中",
  low: "低",
};

interface Sheet {
  name: string;
  head: string[];
  rows: string[][];
}

interface ExportPayload {
  title: string;
  sheets: Sheet[];
}

function nameMap(persons: PersonRecord[]) {
  const map = new Map(persons.map((p) => [p.id, p.name]));
  return (id?: string | null) => (id ? (map.get(id) ?? "（已删除）") : "");
}

async function buildPeople(): Promise<ExportPayload> {
  const [persons, relations, events, reminders] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelations(),
    facesDb.listLifeEvents(),
    facesDb.listReminders(),
  ]);
  const nameOf = nameMap(persons);

  const personRows = persons.map((person) => {
    const p = person.profile ?? {};
    return [
      person.name,
      p.title ?? "",
      p.department ?? "",
      p.org ?? "",
      (p.projects ?? []).join("、"),
      (p.tags ?? []).join("、"),
      p.contact ?? "",
      (person.note ?? "").replace(/\s+/g, " "),
    ];
  });

  const relationRows = relations.map((relation: RelationRecord) => [
    nameOf(relation.fromId),
    relation.mutual ? "↔ 双向" : "→ 单向",
    nameOf(relation.toId),
    relation.label,
    (relation.basis ?? "").replace(/\s+/g, " "),
    (relation.note ?? "").replace(/\s+/g, " "),
  ]);

  const eventRows = events.map((event) => [
    event.date,
    event.dateEnd ?? "",
    event.precision ?? "day",
    event.title,
    event.kind ?? "",
    (event.personIds ?? []).map((id) => nameOf(id)).join("、"),
    event.place ?? "",
    (event.detail ?? "").replace(/\s+/g, " "),
  ]);

  const reminderRows = reminders.map((reminder) => [
    reminder.due ?? "",
    reminder.done ? "已完成" : "待办",
    reminder.kind ?? "custom",
    reminder.title,
    (reminder.personIds ?? []).map((id) => nameOf(id)).join("、"),
    (reminder.detail ?? "").replace(/\s+/g, " "),
  ]);

  return {
    title: "知脉 Connect · 人物关系库",
    sheets: [
      {
        name: "人物档案",
        head: ["姓名", "职位", "部门", "单位", "负责事项", "标签", "联系方式", "备注"],
        rows: personRows,
      },
      {
        name: "人物关系",
        head: ["来源", "方向", "对象", "关系", "依据", "备注"],
        rows: relationRows,
      },
      {
        name: "日历事件",
        head: ["开始", "结束", "日期精度", "事件", "类型", "相关人物", "地点", "详情"],
        rows: eventRows,
      },
      {
        name: "提醒待办",
        head: ["到期", "状态", "类型", "提醒", "相关人物", "详情"],
        rows: reminderRows,
      },
    ],
  };
}

async function buildProjects(): Promise<ExportPayload> {
  const [persons, projects] = await Promise.all([facesDb.listPersons(), facesDb.listProjects()]);
  const nameOf = nameMap(persons);

  const rows = projects.map((project) => [
    project.title,
    STATUS_LABEL[project.status],
    PRIORITY_LABEL[project.priority],
    project.department ?? "",
    project.ownerName || nameOf(project.ownerId) || "",
    (project.memberIds ?? [])
      .map((id) => nameOf(id))
      .filter(Boolean)
      .join("、"),
    project.due ?? "",
    (project.tags ?? []).join("、"),
    (project.detail ?? "").replace(/\s+/g, " "),
  ]);

  return {
    title: "知脉 Connect · 事务清单",
    sheets: [
      {
        name: "事务",
        head: ["事务名称", "状态", "优先级", "部门", "负责人", "参与人", "截止", "标签", "说明"],
        rows,
      },
    ],
  };
}

async function buildPayload(scope: ExportScope) {
  return scope === "people" ? buildPeople() : buildProjects();
}

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function toMarkdown(payload: ExportPayload) {
  const parts = [`# ${payload.title}`, "", `导出时间：${new Date().toLocaleString()}`, ""];
  for (const sheet of payload.sheets) {
    parts.push(`## ${sheet.name}（${sheet.rows.length}）`, "");
    if (!sheet.rows.length) {
      parts.push("（暂无数据）", "");
      continue;
    }
    parts.push(`| ${sheet.head.join(" | ")} |`);
    parts.push(`| ${sheet.head.map(() => "---").join(" | ")} |`);
    for (const row of sheet.rows) parts.push(`| ${row.map(escapeCell).join(" | ")} |`);
    parts.push("");
  }
  return parts.join("\n");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toHtml(payload: ExportPayload) {
  const tables = payload.sheets
    .map((sheet) => {
      const head = `<tr>${sheet.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const body = sheet.rows.length
        ? sheet.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
            .join("")
        : `<tr><td colspan="${sheet.head.length}">暂无数据</td></tr>`;
      return `<h2>${escapeHtml(sheet.name)}（${sheet.rows.length}）</h2><table>${head}${body}</table>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(payload.title)}</title>
<style>
  body { font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #1c1a20; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  .meta { color: #7c7688; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #d8d3e0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f3eff8; }
</style></head><body>
<h1>${escapeHtml(payload.title)}</h1>
<div class="meta">导出时间：${escapeHtml(new Date().toLocaleString())}</div>
${tables}
</body></html>`;
}

async function exportDocx(payload: ExportPayload, filename: string) {
  const {
    Document,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    HeadingLevel,
    WidthType,
    ShadingType,
    BorderStyle,
  } = await import("docx");

  const border = { style: BorderStyle.SINGLE, size: 1, color: "D8D3E0" };
  const borders = { top: border, bottom: border, left: border, right: border };

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(payload.title)] }),
    new Paragraph({ children: [new TextRun(`导出时间：${new Date().toLocaleString()}`)] }),
  ];

  for (const sheet of payload.sheets) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun(`${sheet.name}（${sheet.rows.length}）`)],
      }),
    );
    if (!sheet.rows.length) {
      children.push(new Paragraph({ children: [new TextRun("暂无数据")] }));
      continue;
    }
    const total = 9360;
    const colWidth = Math.floor(total / sheet.head.length);
    const widths = sheet.head.map((_, index) =>
      index === sheet.head.length - 1 ? total - colWidth * (sheet.head.length - 1) : colWidth,
    );
    const cell = (text: string, index: number, header: boolean) =>
      new TableCell({
        borders,
        width: { size: widths[index], type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        shading: header ? { fill: "F3EFF8", type: ShadingType.CLEAR } : undefined,
        children: [new Paragraph({ children: [new TextRun({ text, bold: header, size: 18 })] })],
      });

    children.push(
      new Table({
        width: { size: total, type: WidthType.DXA },
        columnWidths: widths,
        rows: [
          new TableRow({ children: sheet.head.map((h, i) => cell(h, i, true)) }),
          ...sheet.rows.map(
            (row) => new TableRow({ children: row.map((c, i) => cell(c, i, false)) }),
          ),
        ],
      }),
    );
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Microsoft YaHei", size: 20 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  download(await Packer.toBlob(doc), filename);
}

function exportPdf(payload: ExportPayload) {
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) throw new Error("popup-blocked");
  win.document.write(toHtml(payload));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}

/** 导出指定模块的数据；pdf 走浏览器打印（可选「另存为 PDF」），中文不会乱码 */
export async function exportData(scope: ExportScope, format: ExportFormat) {
  const payload = await buildPayload(scope);
  const base = `${scope === "people" ? "知脉-人物关系库" : "知脉-事务清单"}-${stamp()}`;

  switch (format) {
    case "md":
      download(
        new Blob([toMarkdown(payload)], { type: "text/markdown;charset=utf-8" }),
        `${base}.md`,
      );
      break;
    case "docx":
      await exportDocx(payload, `${base}.docx`);
      break;
    case "pdf":
      exportPdf(payload);
      break;
  }

  return payload.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
}
