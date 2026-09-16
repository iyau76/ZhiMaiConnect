"""Apply only the reviewed PR #3 compatibility changes on the repair branch."""
from pathlib import Path
import subprocess

EXPECTED = {
    "src/components/calendar-panel.tsx": "0eeeb709b8ebfa2066e588b31ef8347f505e7569",
    "src/components/relations-panel.tsx": "9a06dc511ea18a990321ec08843ef7f57012ce7f",
    "src/lib/family-tree-layout.ts": "f70c16f2da5b69919bb850a81daec3143d90fcb4",
    "src/lib/archive-mutation-plan.ts": "f2cd723eeebac44e9533cb88ccd64f37dae58ddc",
    "e2e/event-month-precision.spec.ts": "10fc322da1c9fce330a84387343f06ceeb8e6e1c",
}
for name, expected in EXPECTED.items():
    actual = subprocess.check_output(["git", "hash-object", name], text=True).strip()
    if actual != expected:
        raise RuntimeError(f"Refusing to overwrite changed source: {name} ({actual})")


def replace_once(name: str, old: str, new: str) -> None:
    path = Path(name)
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected one matching source block in {name}, got {text.count(old)}")
    path.write_text(text.replace(old, new, 1))


calendar = "src/components/calendar-panel.tsx"
replace_once(calendar, '''const PRECISIONS: DatePrecision[] = ["day", "month"];
const PRECISION_TABS: Record<string, string> = {
  day: "记得具体哪天",
  month: "不记得具体哪天",
};''', '''const PRECISIONS: DatePrecision[] = ["day", "month", "year", "range"];
const PRECISION_TABS: Record<DatePrecision, string> = {
  day: "记得具体哪天",
  month: "只记得某月",
  year: "只记得某年",
  range: "不记得具体哪天",
};''')
replace_once(calendar,
    '    setPrecision(precisionOf(event) === "day" ? "day" : "month");',
    '    setPrecision(precisionOf(event));')
replace_once(calendar, '''    let stored: DatePrecision = precision;

    if (precision === "month") {''', '''    let stored: DatePrecision | undefined = precision;
    let dateText: string | undefined;
    const dateUnchanged =
      previous &&
      precision === precisionOf(previous) &&
      (precision === "day"
        ? selected === previous.date
        : precision === "month"
          ? monthValue === previous.date.slice(0, 7)
          : fuzzyText.trim() === formatFuzzy(previous));

    // Editing a title, participants or time must not reinterpret an old date.
    // Preserve even an implicit precision and the original relative description.
    if (previous && dateUnchanged) {
      date = previous.date;
      dateEnd = previous.dateEnd;
      stored = previous.precision;
      dateText = previous.dateText;
    } else if (precision === "month") {''')
replace_once(calendar, '''      let parsed =
        previous && text === formatFuzzy(previous)
          ? {
              date: previous.date,
              dateEnd: previous.dateEnd,
              precision: precisionOf(previous),
            }
          : parseFuzzyLocal(text);''', '''      let parsed = parseFuzzyLocal(text);''')
replace_once(calendar, '''      stored = parsed.precision;
    }''', '''      stored = parsed.precision;
      dateText = text;
    }''')
replace_once(calendar, '      dateText: stored === "day" ? undefined : fuzzyText.trim(),', '      dateText,')
replace_once(calendar, '''              onClick={() => setPrecision(item)}
              className={cn(''', '''              onClick={() => setPrecision(item)}
              aria-pressed={precision === item}
              className={cn(''')

layout = "src/lib/family-tree-layout.ts"
replace_once(layout,
    'export type FamilyTreeEdgeKind = "parent" | "spouse" | "sibling";',
    'export type FamilyTreeEdgeKind = "parent" | "spouse" | "sibling" | "kinship";')
replace_once(layout, '''  if (predicate === "spouse_of") return "spouse";
  return null;''', '''  if (predicate === "spouse_of") return "spouse";
  // Keep every accepted kinship edge visible, even without a generational rule.
  return isFamilyTreeRelation(relation) ? "kinship" : null;''')
replace_once(layout, '''    if (kind !== "parent") union(relation.fromId, relation.toId);''', '''    // Generic kinship can span generations. It must not collapse a parent and
    // child into one row or manufacture missing parents to complete a pedigree.
    if (kind === "spouse" || kind === "sibling") union(relation.fromId, relation.toId);''')

relations = "src/components/relations-panel.tsx"
replace_once(relations, '''      const nodeById = new Map(familyTree.nodes.map((node) => [node.id, node]));
      const nodes = familyTree.nodes.map((node) => ({
        ...node,
        group: "",
        color: graphColor(`generation:${node.generation}`),
      }));''', '''      const nodes = familyTree.nodes.map((node) => ({
        ...node,
        ...(positions[node.id] ?? {}),
        group: "",
        color: graphColor(`generation:${node.generation}`),
      }));
      // Nodes, edges and labels must all use the same final drag coordinates.
      const nodeById = new Map(nodes.map((node) => [node.id, node]));''')
replace_once(relations, '            mutual: edge.kind !== "parent",', '            mutual: isMutualRelation(relation),')
replace_once(relations, '''      if (edge.familyKind === "spouse") {
        return `M ${a.x + 18} ${a.y} H ${b.x - 18}`;
      }
''', '')
replace_once(relations, '''      const midY = a.y + (b.y - a.y) * 0.52;
      return `M ${a.x} ${a.y + 20} V ${midY} H ${b.x} V ${b.y - 24}`;''', '''      if (edge.familyKind === "parent") {
        const midY = a.y + (b.y - a.y) * 0.52;
        return `M ${a.x} ${a.y + 20} V ${midY} H ${b.x} V ${b.y - 24}`;
      }
      // Other kinship and spouse edges use the common endpoint-aware path below.
      // In particular, a dragged spouse may no longer share the other node's y.''')

archive = "src/lib/archive-mutation-plan.ts"
replace_once(archive, '''  if (/^\\d{4}-\\d{2}$/.test(value)) return "month" as const;
  return "day" as const;''', '''  if (/^\\d{4}-\\d{2}$/.test(value)) return "month" as const;
  // A full date was already accepted before shorthand dates were added. Omitted
  // precision means "leave it alone", not "set day" (and must allow unset).
  return undefined;''')
replace_once("e2e/event-month-precision.spec.ts", 'name: "不记得具体哪天"', 'name: "只记得某月"')
print("Applied compatibility changes to five reviewed files.")
