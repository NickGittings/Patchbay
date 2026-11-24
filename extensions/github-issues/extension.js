// Imports a GitHub repository's issues into the story board: the repository becomes an epic,
// each milestone a feature, and each issue a story (under its milestone, if it has one).
// Import only: Patchbay never writes to GitHub.
let pb;
let panel;
let disposables = [];
let status = "";
let busy = false;

const VIEW = "patchbay.github-issues.panel";
const TOKEN = "token";
const DEFAULT_API = "https://api.github.com";
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
const script = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

/** `owner/name`, or a github.com URL of the repository. */
export function parseRepo(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const match = text.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!match) throw new Error("Enter the repository as owner/name");
  return `${match[1]}/${match[2]}`;
}
/** The REST base: api.github.com, or `https://host/api/v3` for GitHub Enterprise Server. */
export function apiBase(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!text) return DEFAULT_API;
  const url = new URL(text);
  if (url.protocol !== "https:")
    throw new Error("The API address must use https");
  return url.href.replace(/\/+$/, "");
}
/** The `next` page from a Link header. */
export function nextLink(headers) {
  const link = headers.find(([name]) => name === "link")?.[1] ?? "";
  return link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}
/** Task-list items in an issue body, the issue's acceptance criteria. */
export function taskList(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => clip(line, CRITERION_LIMIT));
}

/** Board items for a repository's issues (pull requests are skipped). */
export function toItems(repo, issues, htmlBase = "https://github.com") {
  const epic = `${repo}`;
  const items = [
    {
      externalId: epic,
      kind: "epic",
      title: clip(repo, TITLE_LIMIT),
      url: `${htmlBase}/${repo}`,
      description: "",
    },
  ];
  const milestones = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const milestone = issue.milestone;
    let parent = null;
    if (milestone) {
      parent = `${repo}/milestone/${milestone.number}`;
      if (!milestones.has(parent))
        milestones.set(parent, {
          externalId: parent,
          kind: "feature",
          title: clip(String(milestone.title ?? "").trim() || `Milestone ${milestone.number}`, TITLE_LIMIT),
          parent: epic,
          description: clip(String(milestone.description ?? ""), DESCRIPTION_LIMIT),
          url: milestone.html_url ?? null,
        });
    }
    const body = String(issue.body ?? "");
    items.push({
      externalId: `${repo}#${issue.number}`,
      kind: "story",
      title: clip(String(issue.title ?? "").trim() || `Issue ${issue.number}`, TITLE_LIMIT),
      parent,
      description: clip(body, DESCRIPTION_LIMIT),
      acceptance: taskList(body),
      url: issue.html_url ?? null,
    });
  }
  return [...items.slice(0, 1), ...milestones.values(), ...items.slice(1)];
}

async function settings() {
  const workspace = await pb.workspace.get();
  const key = `settings:${workspace?.projectId ?? ""}`;
  return {
    key,
    value: (await pb.storage.get(key)) ?? { repo: "", labels: "", api: "" },
  };
}

/** Every open issue (or those with `labels`), following pagination up to MAX_ISSUES. */
export async function fetchIssues(http, { repo, labels, api }, authenticated) {
  const params = new URLSearchParams({ state: "open", per_page: "100" });
  if (labels?.trim()) params.set("labels", labels.trim());
  let url = `${apiBase(api)}/repos/${repo}/issues?${params}`;
  const issues = [];
  while (url && issues.length < MAX_ISSUES) {
    const response = await http.fetch({
      url,
      headers: [
        ["Accept", "application/vnd.github+json"],
        ["X-GitHub-Api-Version", "2022-11-28"],
      ],
      auth: authenticated ? { secret: TOKEN, scheme: "bearer" } : undefined,
    });
    if (response.status === 404)
      throw new Error(
        `${repo} wasn't found. Private repositories need a token with Issues access.`,
      );
    if (response.status === 401)
      throw new Error("GitHub rejected the token. Set a new one.");
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub rate limit reached. Set a token or try again later.",
      );
    if (response.status !== 200)
      throw new Error(`GitHub answered ${response.status}`);
    const page = JSON.parse(response.body);
    if (!Array.isArray(page))
      throw new Error("GitHub sent an unexpected response");
    issues.push(...page);
    url = nextLink(response.headers);
  }
  return issues.slice(0, MAX_ISSUES);
}

async function importIssues() {
  const { value } = await settings();
  if (!value.repo) {
    status = "Choose a repository in the GitHub Issues panel first.";
    await render();
    throw new Error(status);
  }
  busy = true;
  status = `Reading ${value.repo}…`;
  await render();
  try {
    const repo = parseRepo(value.repo);
    const issues = await fetchIssues(
      pb.http,
      { ...value, repo },
      await pb.secrets.has(TOKEN),
    );
    const base = apiBase(value.api);
    const html =
      base === DEFAULT_API ? "https://github.com" : new URL(base).origin;
    const report = await pb.stories.upsert(toItems(repo, issues, html));
    status = `Imported ${repo}: ${report.created} new, ${report.updated} updated, ${report.unchanged} unchanged.`;
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
  const token = await pb.secrets.has(TOKEN).catch(() => false);
  await panel.render(`<style>
body{font:13px system-ui;color:#ddd;background:#1d2026;padding:12px;margin:0}
label{display:grid;gap:4px;margin:0 0 10px}input{padding:6px;background:#111;color:#eee;border:1px solid #444;border-radius:4px}
button{padding:6px 10px;margin:0 6px 6px 0}p{line-height:1.5;color:#aaa}.status{color:#ddd}
</style>
<form id="f">
<label>Repository<input name="repo" placeholder="owner/name" value="${escape(value.repo)}"></label>
<label>Labels (optional, comma-separated)<input name="labels" placeholder="ready,customer" value="${escape(value.labels)}"></label>
<label>API address (GitHub Enterprise only)<input name="api" placeholder="${DEFAULT_API}" value="${escape(value.api)}"></label>
<button type="submit">Save</button>
</form>
<p>Token: ${token ? "saved in your keychain" : "none (public repositories only, with low rate limits)"}</p>
<button id="token">${token ? "Replace token" : "Set token"}</button>${token ? '<button id="forget">Forget token</button>' : ""}
<p><button id="import" ${busy ? "disabled" : ""}>Import open issues</button></p>
<p class="status">${escape(status)}</p>
<p>The repository becomes an epic, milestones become features and issues become stories. Importing again updates their text; status and worktree links stay in Patchbay. GitHub Enterprise servers must first be approved in Settings → Extensions.</p>
<script>
const send=(m)=>patchbayView.postMessage(m)
document.querySelector('#f').onsubmit=(e)=>{e.preventDefault();const d=new FormData(e.target);send({action:'save',repo:d.get('repo'),labels:d.get('labels'),api:d.get('api')})}
document.querySelector('#token').onclick=()=>send({action:'token'})
document.querySelector('#forget')?.addEventListener('click',()=>send({action:'forget'}))
document.querySelector('#import').onclick=()=>send({action:'import'})
</script>`);
}

async function onMessage(message) {
  try {
    if (message?.action === "save") {
      const { key } = await settings();
      const repo = message.repo ? parseRepo(message.repo) : "";
      const api = message.api ? apiBase(message.api) : "";
      await pb.storage.set(key, {
        repo,
        labels: String(message.labels ?? "").slice(0, 200),
        api,
      });
      status = "Saved.";
    } else if (message?.action === "token") {
      const saved = await pb.secrets.prompt(TOKEN, {
        label: "GitHub token",
        description:
          "A fine-grained personal access token with read-only Issues access to the repository.",
      });
      status = saved ? "Token saved." : "";
    } else if (message?.action === "forget") {
      await pb.secrets.delete(TOKEN);
      status = "Token forgotten.";
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
    pb.commands.registerCommand("patchbay.github-issues.import", importIssues),
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
