// Imports epics, features and stories from a JSON, CSV or Markdown file the person chooses.
// Re-importing the same file updates the items it created instead of duplicating them.
let pb;
let disposables = [];

const KINDS = { epic: "epic", feature: "feature" };
/** Tracker item types become board kinds; anything else (story, task, bug, PBI…) is a story. */
export function kindOf(value) {
  return (
    KINDS[
      String(value ?? "")
        .trim()
        .toLowerCase()
    ] ?? "story"
  );
}
const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "item";
/** `- [ ] criterion` lines (or plain lines when `plain`) as acceptance criteria. */
export function criteria(text, plain = false) {
  if (Array.isArray(text)) return text.map(String).filter((c) => c.trim());
  return String(text ?? "")
    .split(/\r?\n/)
    .map(
      (line) =>
        line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1] ??
        (plain ? line.trim() : ""),
    )
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Make a batch the board accepts: a story whose parent is an epic goes under a feature named
 * after that epic, and a feature without an epic goes under one "Imported" epic.
 */
export function normalize(items, source = "import") {
  const byId = new Map(items.map((item) => [item.externalId, item]));
  const out = [...items];
  const added = new Set();
  const add = (item) => {
    if (added.has(item.externalId) || byId.has(item.externalId)) return;
    added.add(item.externalId);
    out.push(item);
  };
  for (const item of out.slice()) {
    const parent = item.parent ? byId.get(item.parent) : undefined;
    if (item.kind === "story" && parent?.kind === "epic") {
      const feature = `${parent.externalId}/feature`;
      add({
        externalId: feature,
        kind: "feature",
        title: parent.title,
        parent: parent.externalId,
      });
      item.parent = feature;
    } else if (item.kind === "story" && parent?.kind === "story") {
      item.parent = null;
    } else if (item.kind === "feature" && !item.parent) {
      const epic = `${source}:epic`;
      add({ externalId: epic, kind: "epic", title: "Imported" });
      item.parent = epic;
    } else if (item.kind === "epic") {
      item.parent = null;
    }
  }
  return out;
}

function item(raw, fallbackId) {
  const title = String(raw.title ?? raw.summary ?? raw.name ?? "").trim();
  if (!title) return null;
  const url =
    typeof raw.url === "string" && /^https?:\/\//.test(raw.url)
      ? raw.url
      : null;
  return {
    externalId: String(raw.externalId ?? raw.id ?? raw.key ?? fallbackId),
    kind: kindOf(raw.kind ?? raw.type),
    title,
    parent: raw.parent == null || raw.parent === "" ? null : String(raw.parent),
    description: String(raw.description ?? raw.body ?? ""),
    acceptance: criteria(raw.acceptance ?? raw.acceptanceCriteria, true),
    url,
  };
}

/**
 * JSON: an array of items, `{ items: [...] }`, or nested `children`. Items take `id`, `kind`
 * (epic, feature or story), `title`, `parent`, `description`, `acceptance` and `url`. Items
 * without an id are named after their titles, so renaming one imports it again as new.
 */
export function parseJson(text) {
  const data = JSON.parse(text);
  const roots = Array.isArray(data)
    ? data
    : (data.items ?? data.epics ?? data.stories ?? []);
  if (!Array.isArray(roots))
    throw new Error('Expected an array of items or { "items": [...] }');
  const out = [];
  const walk = (raw, parent, path) => {
    if (!raw || typeof raw !== "object") return;
    const parsed = item(
      { ...raw, parent: raw.parent ?? parent },
      `json:${path}/${slug(raw.title ?? raw.name ?? "")}`,
    );
    if (!parsed) return;
    out.push(parsed);
    for (const child of raw.children ?? raw.features ?? raw.stories ?? [])
      walk(child, parsed.externalId, parsed.externalId);
  };
  roots.forEach((raw) => walk(raw, null, ""));
  return out;
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const COLUMNS = {
  id: ["id", "external id", "key", "issue key", "work item id", "issue id"],
  kind: ["kind", "type", "issue type", "work item type"],
  title: ["title", "summary", "name"],
  parent: [
    "parent",
    "parent id",
    "parent key",
    "parent link",
    "epic link",
    "custom field (epic link)",
  ],
  description: ["description", "body", "details"],
  acceptance: [
    "acceptance",
    "acceptance criteria",
    "custom field (acceptance criteria)",
  ],
  url: ["url", "link", "web url"],
};
/** CSV with a header row, including Jira and Azure DevOps exports' column names. */
export function parseCsv(text) {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ""));
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase());
  const column = (key) =>
    COLUMNS[key].map((n) => names.indexOf(n)).find((i) => i >= 0) ?? -1;
  const at = Object.fromEntries(
    Object.keys(COLUMNS).map((key) => [key, column(key)]),
  );
  if (at.title < 0) throw new Error("The CSV needs a Title or Summary column");
  return rows.flatMap((row, i) => {
    const value = (key) => (at[key] >= 0 ? (row[at[key]] ?? "").trim() : "");
    const parsed = item(
      {
        id: value("id") || undefined,
        kind: value("kind"),
        title: value("title"),
        parent: value("parent") || null,
        description: value("description"),
        acceptance: criteria(value("acceptance"), true),
        url: value("url"),
      },
      `csv:${slug(value("title"))}-${i + 1}`,
    );
    return parsed ? [parsed] : [];
  });
}

/**
 * Markdown outline: `#` epics, `##` features and `###` stories. Text under a heading is its
 * description, and `- [ ]` checklist lines are its acceptance criteria.
 */
export function parseMarkdown(text) {
  const out = [];
  const stack = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const lines = current.lines;
    current.item.acceptance = criteria(lines.join("\n"));
    current.item.description = lines
      .filter((l) => !/^\s*[-*]\s+\[[ xX]\]\s+/.test(l))
      .join("\n")
      .trim();
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      current?.lines.push(line);
      continue;
    }
    finish();
    const depth = heading[1].length;
    const kind = ["epic", "feature", "story"][depth - 1];
    stack.length = depth - 1;
    const parent = stack[depth - 2] ?? null;
    const title = heading[2].trim();
    const externalId = `md:${[...stack.map((s) => s.slug), slug(title)].join("/")}`;
    const item = {
      externalId,
      kind,
      title,
      parent: parent?.externalId ?? null,
      description: "",
    };
    stack[depth - 1] = { slug: slug(title), externalId };
    out.push(item);
    current = { item, lines: [] };
  }
  finish();
  return out;
}

/** Parse by extension: .json, .csv, .md or .markdown. */
export function parseFile(name, text) {
  const extension = name.toLowerCase().split(".").pop();
  const items =
    extension === "json"
      ? parseJson(text)
      : extension === "csv"
        ? parseCsv(text)
        : ["md", "markdown"].includes(extension)
          ? parseMarkdown(text)
          : null;
  if (!items) throw new Error("Choose a .json, .csv or .md file");
  return normalize(items, "file");
}

async function importFile() {
  const file = await pb.files.pick({
    title: "Import stories",
    extensions: ["json", "csv", "md", "markdown"],
  });
  if (!file) return null;
  const items = parseFile(file.name, file.text);
  if (!items.length) throw new Error(`${file.name} has no items to import`);
  const report = await pb.stories.upsert(items);
  await pb.window.showMessage(
    `Imported ${file.name}: ${report.created} new, ${report.updated} updated, ${report.unchanged} unchanged`,
  );
  return report;
}

export async function activate(patchbay) {
  pb = patchbay;
  disposables = [
    pb.commands.registerCommand("patchbay.story-import.import", importFile),
  ];
  await Promise.all(disposables.map((d) => d.ready));
}
export function deactivate() {
  for (const d of disposables) d.dispose();
  disposables = [];
}
