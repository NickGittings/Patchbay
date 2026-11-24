// Imports epics, features and stories from a JSON, CSV or Markdown file the person chooses.
// Re-importing the same file updates the items it created instead of duplicating them.
let pb;
let disposables = [];

const KINDS = new Map([["epic", "epic"], ["feature", "feature"]]);
const encoder = new TextEncoder();
/** Tracker item types become board kinds; anything else (story, task, bug, PBI…) is a story. */
export function kindOf(value) {
  return KINDS.get(String(value ?? "").trim().toLowerCase()) ?? "story";
}
const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "item";
function hash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(value))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

/** Reserve generated IDs without colliding with other items or explicit tracker IDs. */
function idAllocator(reserved = []) {
  const used = new Set(reserved);
  return (preferred) => {
    const base = encoder.encode(preferred).length <= 240
      ? preferred
      : `file:${hash(preferred)}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}~${suffix}`;
    used.add(id);
    return id;
  };
}
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
  const allocate = idAllocator(byId.keys());
  const features = new Map();
  let importedEpic;
  for (const item of items) {
    const parent = byId.get(item.parent);
    if (item.kind === "story" && parent?.kind === "epic") {
      let feature = features.get(parent.externalId);
      if (!feature) {
        feature = allocate(`${parent.externalId}/feature`);
        features.set(parent.externalId, feature);
        out.push({
          externalId: feature,
          kind: "feature",
          title: parent.title,
          parent: parent.externalId,
        });
      }
      item.parent = feature;
    } else if (item.kind === "story" && parent?.kind !== "feature") {
      item.parent = null;
    } else if (item.kind === "feature" && parent?.kind !== "epic") {
      if (!importedEpic) {
        importedEpic = allocate(`${source}:epic`);
        out.push({ externalId: importedEpic, kind: "epic", title: "Imported" });
      }
      item.parent = importedEpic;
    } else if (item.kind === "epic") {
      item.parent = null;
    }
  }
  return out;
}

const explicitId = (raw) => raw.externalId ?? raw.id ?? raw.key;
const titleOf = (raw) => String(raw.title ?? raw.summary ?? raw.name ?? "").trim();
const childrenOf = (raw) => raw.children ?? raw.features ?? raw.stories ?? [];

function item(raw, fallbackId) {
  const title = titleOf(raw);
  if (!title) return null;
  const url =
    typeof raw.url === "string" && /^https?:\/\//.test(raw.url)
      ? raw.url
      : null;
  return {
    externalId: String(explicitId(raw) ?? fallbackId()),
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
  const reserved = [];
  const reserve = (raw) => {
    if (!raw || typeof raw !== "object" || !titleOf(raw)) return;
    const id = explicitId(raw);
    if (id != null) reserved.push(String(id));
    for (const child of childrenOf(raw)) reserve(child);
  };
  roots.forEach(reserve);
  const allocate = idAllocator(reserved);
  const out = [];
  const walk = (raw, parent) => {
    if (!raw || typeof raw !== "object") return;
    const parsed = item(
      { ...raw, parent: raw.parent ?? parent },
      () => allocate(`json:${parent ?? ""}/${slug(titleOf(raw))}`),
    );
    if (!parsed) return;
    out.push(parsed);
    for (const child of childrenOf(raw)) walk(child, parsed.externalId);
  };
  roots.forEach((raw) => walk(raw, null));
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
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([key, columns]) => [
    key, columns.map((name) => names.indexOf(name)).filter((i) => i >= 0),
  ]));
  if (!at.title.length) throw new Error("The CSV needs a Title or Summary column");
  const values = (row, key) => at[key].map((i) => (row[i] ?? "").trim()).filter(Boolean);
  const records = rows.map((row) => {
    const value = (key) => values(row, key)[0] ?? "";
    return {
      ids: values(row, "id"),
      kind: kindOf(value("kind")),
      title: value("title"),
      parent: value("parent") || null,
      description: value("description"),
      acceptance: value("acceptance"),
      url: value("url"),
    };
  }).filter((row) => row.title);
  const canonicalIds = new Set(records.flatMap((row) => row.ids.slice(0, 1)));
  const aliases = new Map();
  for (const row of records)
    for (const alias of row.ids.slice(1))
      if (!canonicalIds.has(alias))
        aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== row.ids[0] ? null : row.ids[0]);
  const allocate = idAllocator(canonicalIds);
  return records.map((row) => {
    const parent = aliases.get(row.parent) ?? row.parent;
    return item({ ...row, id: row.ids[0], parent }, () => {
      const key = JSON.stringify([row.kind, parent, row.title]);
      return allocate(`csv:${slug(row.title)}~${hash(key)}`);
    });
  });
}

/**
 * Markdown outline: `#` epics, `##` features and `###` stories. Text under a heading is its
 * description, and `- [ ]` checklist lines are its acceptance criteria.
 */
export function parseMarkdown(text) {
  const out = [];
  const stack = [];
  const allocate = idAllocator();
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
    if (!title) {
      current = null;
      continue;
    }
    const path = parent ? `${parent.slice(3)}/` : "/".repeat(depth - 1);
    const externalId = allocate(`md:${path}${slug(title)}`);
    const item = {
      externalId,
      kind,
      title,
      parent,
      description: "",
    };
    stack[depth - 1] = externalId;
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
