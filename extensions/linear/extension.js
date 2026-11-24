// Imports a Linear team's open issues into the story board: initiatives become epics, projects
// features and issues stories. Projects outside any initiative go under one epic for the team.
// Import only: Patchbay never writes to Linear.
let pb;
let panel;
let disposables = [];
let status = "";
let busy = false;

const VIEW = "patchbay.linear.panel";
const KEY = "apiKey";
const ENDPOINT = "https://api.linear.app/graphql";
/** Most issues one import reads (10 pages of 100). */
export const MAX_ISSUES = 1000;
const TITLE_LIMIT = 500;
const DESCRIPTION_LIMIT = 64 * 1024;
const CRITERION_LIMIT = 2000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Fit the board's UTF-8 limits without splitting a code point. */
function clip(text, limit) {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;
  const suffix = "…";
  let end = limit - encoder.encode(suffix).length;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end)) + suffix;
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export const ISSUES_QUERY = `query PatchbayIssues($team: String!, $after: String, $closed: [String!]) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { type: { nin: $closed } } }) {
    nodes {
      id identifier title description url
      project { id name description url initiatives(first: 1) { nodes { id name description url } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** A team key such as ENG. */
export function parseTeam(value) {
  const team = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9_]{1,10}$/.test(team))
    throw new Error("Enter the team key, such as ENG");
  return team;
}
/** Checklist lines in an issue description become acceptance criteria. */
export function checklist(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => clip(line, CRITERION_LIMIT));
}

/** Board items for a team's issues. */
export function toItems(team, issues) {
  const epics = new Map();
  const features = new Map();
  const stories = [];
  const teamEpic = `team:${team}`;
  for (const issue of issues) {
    let parent = null;
    const project = issue.project;
    if (project) {
      const initiative = project.initiatives?.nodes?.[0];
      const epic = initiative ? `initiative:${initiative.id}` : teamEpic;
      if (!epics.has(epic))
        epics.set(
          epic,
          initiative
            ? {
                externalId: epic,
                kind: "epic",
                title: clip(String(initiative.name ?? "").trim() || "Initiative", TITLE_LIMIT),
                description: clip(String(initiative.description ?? ""), DESCRIPTION_LIMIT),
                url: initiative.url ?? null,
              }
            : {
                externalId: epic,
                kind: "epic",
                title: `${team} projects`,
                description: "",
              },
        );
      parent = `project:${project.id}`;
      if (!features.has(parent))
        features.set(parent, {
          externalId: parent,
          kind: "feature",
          title: clip(String(project.name ?? "").trim() || "Project", TITLE_LIMIT),
          parent: epic,
          description: clip(String(project.description ?? ""), DESCRIPTION_LIMIT),
          url: project.url ?? null,
        });
    }
    const description = String(issue.description ?? "");
    stories.push({
      externalId: String(issue.identifier || issue.id),
      kind: "story",
      title: clip(String(issue.title ?? "").trim() || String(issue.identifier || issue.id), TITLE_LIMIT),
      parent,
      description: clip(description, DESCRIPTION_LIMIT),
      acceptance: checklist(description),
      url: issue.url ?? null,
    });
  }
  return [...epics.values(), ...features.values(), ...stories];
}

/** All matching issues, following the cursor up to MAX_ISSUES. */
export async function fetchIssues(http, team, includeClosed) {
  const issues = [];
  let after = null;
  do {
    const response = await http.fetch({
      url: ENDPOINT,
      method: "POST",
      headers: [["Content-Type", "application/json"]],
      body: JSON.stringify({
        query: ISSUES_QUERY,
        variables: {
          team,
          after,
          closed: includeClosed ? [] : ["completed", "canceled", "duplicate"],
        },
      }),
      auth: { secret: KEY, scheme: "raw" },
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("Linear rejected the API key. Set a new one.");
    if (response.status === 429)
      throw new Error("Linear rate limit reached. Try again later.");
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error(`Linear answered ${response.status}`);
    }
    if (data.errors?.length)
      throw new Error(`Linear: ${data.errors[0].message}`);
    const page = data.data?.issues;
    if (!page || !Array.isArray(page.nodes))
      throw new Error("Linear sent an unexpected response");
    issues.push(...page.nodes);
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after && issues.length < MAX_ISSUES);
  return issues.slice(0, MAX_ISSUES);
}

async function settings() {
  const workspace = await pb.workspace.get();
  const key = `settings:${workspace?.projectId ?? ""}`;
  return {
    key,
    value: (await pb.storage.get(key)) ?? { team: "", includeClosed: false },
  };
}

async function importIssues() {
  const { value } = await settings();
  if (!value.team) {
    status = "Enter a team key in the Linear panel first.";
    await render();
    throw new Error(status);
  }
  if (!(await pb.secrets.has(KEY))) {
    status = "Set a Linear API key in the Linear panel first.";
    await render();
    throw new Error(status);
  }
  busy = true;
  status = `Reading ${value.team}…`;
  await render();
  try {
    const team = parseTeam(value.team);
    const issues = await fetchIssues(pb.http, team, !!value.includeClosed);
    const report = await pb.stories.upsert(toItems(team, issues));
    status = `Imported ${team}: ${report.created} new, ${report.updated} updated, ${report.unchanged} unchanged.`;
    await pb.window.showMessage(status);
    return report;
  } catch (e) {
    status = String(e?.message ?? e);
    throw e;
  } finally {
    busy = false;
    await render();
  }
}

async function render() {
  if (!panel) return;
  const { value } = await settings();
  const key = await pb.secrets.has(KEY).catch(() => false);
  await panel.render(`<style>
body{font:13px system-ui;color:#ddd;background:#1d2026;padding:12px;margin:0}
label{display:grid;gap:4px;margin:0 0 10px}input:not([type]){padding:6px;background:#111;color:#eee;border:1px solid #444;border-radius:4px}
label.check{display:flex;align-items:center;gap:6px}
button{padding:6px 10px;margin:0 6px 6px 0}p{line-height:1.5;color:#aaa}.status{color:#ddd}
</style>
<form id="f">
<label>Team key<input name="team" placeholder="ENG" value="${escape(value.team)}"></label>
<label class="check"><input type="checkbox" name="closed" ${value.includeClosed ? "checked" : ""}> Include completed and canceled issues</label>
<button type="submit">Save</button>
</form>
<p>API key: ${key ? "saved in your keychain" : "not set"}</p>
<button id="key">${key ? "Replace API key" : "Set API key"}</button>${key ? '<button id="forget">Forget API key</button>' : ""}
<p><button id="import" ${busy || !key ? "disabled" : ""}>Import issues</button></p>
<p class="status">${escape(status)}</p>
<p>Initiatives become epics, projects features and issues stories. Importing again updates their text; status and worktree links stay in Patchbay.</p>
<script>
const send=(m)=>patchbayView.postMessage(m)
document.querySelector('#f').onsubmit=(e)=>{e.preventDefault();const d=new FormData(e.target);send({action:'save',team:d.get('team'),includeClosed:d.get('closed')==='on'})}
document.querySelector('#key').onclick=()=>send({action:'key'})
document.querySelector('#forget')?.addEventListener('click',()=>send({action:'forget'}))
document.querySelector('#import').onclick=()=>send({action:'import'})
</script>`);
}

async function onMessage(message) {
  try {
    if (message?.action === "save") {
      const { key } = await settings();
      const team = message.team ? parseTeam(message.team) : "";
      await pb.storage.set(key, {
        team,
        includeClosed: !!message.includeClosed,
      });
      status = "Saved.";
    } else if (message?.action === "key") {
      const saved = await pb.secrets.prompt(KEY, {
        label: "Linear API key",
        description:
          "A personal API key from Linear: Settings → Account → Security & access.",
      });
      status = saved ? "API key saved." : "";
    } else if (message?.action === "forget") {
      await pb.secrets.delete(KEY);
      status = "API key forgotten.";
    } else if (message?.action === "import") {
      await importIssues().catch(() => {});
      return;
    }
  } catch (e) {
    status = String(e?.message ?? e);
  }
  await render();
}

export async function activate(patchbay) {
  pb = patchbay;
  disposables = [
    pb.commands.registerCommand("patchbay.linear.import", importIssues),
    pb.views.registerWebviewView(VIEW, {
      resolve(view) {
        panel = view;
        void render();
      },
      onMessage: (message) => void onMessage(message),
    }),
  ];
  await Promise.all(disposables.map((d) => d.ready));
}
export function deactivate() {
  for (const d of disposables) d.dispose();
  disposables = [];
  panel = undefined;
}
