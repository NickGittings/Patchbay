//! Opt-in provider hook configuration and a silent, portable native reporter.
//! Reporting is passive: no provider decisions or trust bypasses. The only stdout is
//! an answer the user gave in Chat to the provider's own question tool.
//! Planner hooks also hand native Claude plans to the authenticated desktop bridge.
use crate::adapters::Adapter;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const SESSION_ENV: &str = "PATCHBAY_REPORT_SESSION";
pub const GENERATION_ENV: &str = "PATCHBAY_REPORT_GENERATION";
pub const PROVIDER_ENV: &str = "PATCHBAY_REPORT_PROVIDER";
/// Set on run & test detection sessions: their `PreToolUse` hook denies reading or
/// searching secret files ([`secret_path`]).
pub const SECRET_GUARD_ENV: &str = "PATCHBAY_SECRET_GUARD";
pub const JOURNAL_ENV: &str = "PATCHBAY_REPORT_DIR";
const MARKER: &str = "Patchbay status v1";
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub session: String,
    pub generation: u64,
    pub provider: Adapter,
    pub sequence: u64,
    pub at_ms: u64,
    pub event: String,
    pub conversation: String,
    pub turn: Option<String>,
    pub prompt: Option<String>,
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    /// Why a session started (`startup`, `resume`, `clear`, `compact`).
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default)]
    pub file_target: bool,
    /// The provider's question tool (`AskUserQuestion`/`request_user_input`) in full.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<UserQuestion>>,
    /// A failed turn the provider attributes to account usage or rate limits.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub usage_limit: bool,
}

/// Journaled by the reporter once Chat answered a `PermissionRequest`; no provider sends it.
pub(crate) const PERMISSION_DECIDED: &str = "PermissionDecided";
/// Questions relayed from one question tool call, and options per question.
pub const QUESTION_LIMIT: usize = 4;
pub const OPTION_LIMIT: usize = 6;
const QUESTION_CHARS: usize = 500;
const LABEL_CHARS: usize = 200;
/// How long the hook waits for an answer from Chat before the provider shows its own menu.
pub const ANSWER_WAIT: std::time::Duration = std::time::Duration::from_secs(120);
/// Provider timeout for `PreToolUse`, which may wait [`ANSWER_WAIT`]; other events stay short.
const QUESTION_HOOK_TIMEOUT: u64 = 150;
const HOOK_TIMEOUT: u64 = 3;

fn hook_timeout(event: &str) -> u64 {
    // Both may wait for the user: a question's answer, or a tool approval.
    if matches!(event, "PreToolUse" | "PermissionRequest") {
        QUESTION_HOOK_TIMEOUT
    } else {
        HOOK_TIMEOUT
    }
}

/// One question from a provider's question tool, bounded for display in Chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestion {
    pub question: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub header: String,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

impl UserQuestion {
    /// Re-apply the display bounds to questions from an untrusted source.
    #[must_use]
    pub fn bounded(questions: Vec<Self>) -> Vec<Self> {
        questions
            .into_iter()
            .filter(|q| !q.question.trim().is_empty())
            .take(QUESTION_LIMIT)
            .map(|q| Self {
                question: clip(&q.question, QUESTION_CHARS),
                header: clip(&q.header, LABEL_CHARS),
                multi_select: q.multi_select,
                options: q
                    .options
                    .into_iter()
                    .filter(|o| !o.label.trim().is_empty())
                    .take(OPTION_LIMIT)
                    .map(|o| QuestionOption {
                        label: clip(&o.label, LABEL_CHARS),
                        description: clip(&o.description, LABEL_CHARS),
                    })
                    .collect(),
            })
            .collect()
    }
}

/// The provider tools that ask the user questions. Codex's `request_user_input_async`
/// (outside Plan mode) names each question `title` and lists its options as plain strings.
fn question_tool(name: &str) -> bool {
    matches!(
        name,
        "AskUserQuestion" | "request_user_input" | "request_user_input_async"
    )
}

/// A question's text: `question`, or `title` from Codex's asynchronous tool.
fn question_text(question: &Value) -> Option<&str> {
    ["question", "title"]
        .iter()
        .find_map(|field| question.get(field)?.as_str())
}

/// Every question of a Claude `AskUserQuestion` or Codex `request_user_input` call.
fn questions(input: &Value) -> Option<Vec<UserQuestion>> {
    if !input
        .get("tool_name")
        .and_then(Value::as_str)
        .is_some_and(question_tool)
    {
        return None;
    }
    let clip_text = |value: &str| value.chars().take(QUESTION_CHARS).collect::<String>();
    let text = |value: &Value, field: &str| {
        value
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(QUESTION_CHARS)
            .collect::<String>()
    };
    let questions = input
        .get("tool_input")?
        .get("questions")?
        .as_array()?
        .iter()
        .take(QUESTION_LIMIT + 1)
        .map(|q| UserQuestion {
            question: clip_text(question_text(q).unwrap_or_default()),
            header: text(q, "header"),
            multi_select: q
                .get("multiSelect")
                .or_else(|| q.get("multi_select"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            options: q
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(OPTION_LIMIT + 1)
                .map(|o| QuestionOption {
                    label: o.as_str().map_or_else(|| text(o, "label"), clip_text),
                    description: text(o, "description"),
                })
                .collect(),
        })
        .collect();
    let questions = UserQuestion::bounded(questions);
    (!questions.is_empty()).then_some(questions)
}

/// The hook output that hands the user's Chat answers to the provider's question tool,
/// one answer per question in order. Claude takes them as the tool's own answers; Codex
/// accepts no replacement input, so its call is declined with the answers as the reason.
fn answer_output(provider: Adapter, input: &Value, answers: &[String]) -> Option<Value> {
    let tool_input = input.get("tool_input")?;
    let asked = tool_input.get("questions")?.as_array()?;
    if asked.is_empty()
        || asked.len() != answers.len()
        || answers.iter().any(|a| a.trim().is_empty())
    {
        return None;
    }
    let pairs: Vec<(&str, &str)> = asked
        .iter()
        .zip(answers)
        .map(|(q, a)| (question_text(q).unwrap_or_default(), a.as_str()))
        .collect();
    Some(match provider {
        Adapter::Claude => {
            let answers: serde_json::Map<_, _> = pairs
                .iter()
                .map(|(q, a)| ((*q).to_owned(), Value::from(*a)))
                .collect();
            // Claude keys answers by question text, so repeated questions can't be told apart.
            if answers.len() != asked.len() {
                return None;
            }
            let mut updated = tool_input.as_object()?.clone();
            updated.insert("answers".into(), Value::Object(answers));
            json!({"hookSpecificOutput":{
                "hookEventName":"PreToolUse",
                "permissionDecision":"allow",
                "updatedInput":updated,
            }})
        }
        Adapter::Codex => {
            let mut reason = String::from(
                "The user already answered in Patchbay Chat. Use these answers and don't ask again:",
            );
            for (question, answer) in pairs {
                reason.push_str("\n- ");
                reason.push_str(question);
                reason.push_str("\n  Answer: ");
                reason.push_str(answer);
            }
            json!({"hookSpecificOutput":{
                "hookEventName":"PreToolUse",
                "permissionDecision":"deny",
                "permissionDecisionReason":reason,
            }})
        }
    })
}

/// Offer a question to Chat and wait, within the hook's timeout, for the user's answer.
/// Any failure, a skip, or no answer in time leaves the provider's own menu to ask.
fn ask_in_chat(provider: Adapter, input: &Value, questions: Vec<UserQuestion>) -> Option<Value> {
    use crate::agent_bridge::{Action, call_from_env_within};
    // Chat answers what it shows; a call it can't show in full (too many or blank
    // questions) would take answers that can't be handed back, so the menu asks.
    let asked = input
        .get("tool_input")
        .and_then(|t| t.get("questions"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if asked != questions.len() {
        return None;
    }
    let conversation = input
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let response = call_from_env_within(
        Action::AskUser {
            conversation,
            questions,
            permission: false,
        },
        ANSWER_WAIT,
    )
    .ok()?;
    if !response.ok {
        return None;
    }
    let answers: Vec<String> =
        serde_json::from_value(response.result?.get("answers")?.clone()).ok()?;
    answer_output(provider, input, &answers)
}

pub const ALLOW: &str = "Allow";
pub const DENY: &str = "Deny";

/// A tool approval as the one question Chat shows: the tool as its header, what it
/// would run or change as its text. `None` for dialogs Chat answers elsewhere (a
/// question tool, a plan) or can't describe.
fn permission_question(input: &Value) -> Option<UserQuestion> {
    let tool = input.get("tool_name")?.as_str()?;
    if question_tool(tool) || tool == "ExitPlanMode" {
        return None;
    }
    let field = |name: &str| {
        input
            .get("tool_input")?
            .get(name)?
            .as_str()
            .filter(|s| !s.trim().is_empty())
    };
    let subject = ["command", "file_path", "path", "url", "description"]
        .iter()
        .find_map(|name| field(name))
        .unwrap_or("Use this tool");
    Some(UserQuestion {
        question: clip(subject, QUESTION_CHARS),
        header: clip(tool, LABEL_CHARS),
        multi_select: false,
        options: [ALLOW, DENY]
            .map(|label| QuestionOption {
                label: label.into(),
                description: String::new(),
            })
            .into(),
    })
}

/// The provider's decision for a `PermissionRequest` answered in Chat. Anything but
/// [`ALLOW`] denies. Chat sends a denial as [`DENY`], or `Deny: <reason>` so that no
/// reason the user types can read as approval.
fn permission_output(answer: &str) -> Value {
    let decision = if answer == ALLOW {
        json!({"behavior":"allow"})
    } else {
        let note = answer.trim();
        let note = note
            .strip_prefix(DENY)
            .and_then(|rest| rest.strip_prefix(':'))
            .map_or(note, str::trim);
        let message = if note.is_empty() || note == DENY {
            "The user denied this in Patchbay Chat.".to_owned()
        } else {
            format!("The user denied this in Patchbay Chat: {note}")
        };
        json!({"behavior":"deny","message":message})
    };
    json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":decision}})
}

/// Codex hands approvals to an automatic reviewer when its configuration names one;
/// a card would only hold that reviewer up, so those requests stay with Codex.
fn codex_reviews_automatically() -> bool {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")));
    home.is_some_and(|home| {
        let read = |name: &str| std::fs::read_to_string(home.join(name)).ok();
        read("config.toml").is_some_and(|config| {
            automatic_reviewer(&config, &|profile| read(&format!("{profile}.config.toml")))
        })
    })
}

/// Whether the configuration may name a reviewer other than the user. With a `profile`
/// selected in the file, that profile's `approvals_reviewer` (its own file, then its
/// table) decides, else the top-level one. Without one, the command line may select any
/// profile, which a hook can't see, so any profile table naming a reviewer counts.
/// `profile_file` reads `<profile>.config.toml`.
fn automatic_reviewer(config: &str, profile_file: &dyn Fn(&str) -> Option<String>) -> bool {
    let Ok(config) = config.parse::<toml::Table>() else {
        return false;
    };
    let reviewer = |table: &toml::Table| {
        table
            .get("approvals_reviewer")
            .and_then(toml::Value::as_str)
            .map(|value| value != "user")
    };
    let profiles = config.get("profiles").and_then(toml::Value::as_table);
    let top = reviewer(&config).unwrap_or(false);
    match config.get("profile").and_then(toml::Value::as_str) {
        Some(name) => Some(name)
            .filter(|name| !name.contains(['/', '\\', '$', '%']))
            .and_then(profile_file)
            .and_then(|file| reviewer(&file.parse().ok()?))
            .or_else(|| reviewer(profiles?.get(name)?.as_table()?))
            .unwrap_or(top),
        None => {
            top || profiles.is_some_and(|tables| {
                tables
                    .values()
                    .any(|table| table.as_table().and_then(reviewer) == Some(true))
            })
        }
    }
}

/// Offer a tool approval to Chat and wait, within the hook's timeout, for Allow or Deny.
/// Any failure, a skip, or no answer in time leaves the provider's own dialog to ask.
fn ask_permission_in_chat(provider: Adapter, input: &Value) -> Option<Value> {
    use crate::agent_bridge::{Action, call_from_env_within};
    if provider == Adapter::Codex && codex_reviews_automatically() {
        return None;
    }
    let question = permission_question(input)?;
    let conversation = input
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let response = call_from_env_within(
        Action::AskUser {
            conversation,
            questions: vec![question],
            permission: true,
        },
        ANSWER_WAIT,
    )
    .ok()?;
    if !response.ok {
        return None;
    }
    let answers: Vec<String> =
        serde_json::from_value(response.result?.get("answers")?.clone()).ok()?;
    Some(permission_output(answers.first()?))
}

/// Templates whose variable names detection may read.
fn template_name(name: &str) -> bool {
    [".example", ".sample", ".template", ".dist"]
        .iter()
        .any(|suffix| name.contains(suffix))
}

/// Whether `path` (a file path, or a glob naming files) names a secret file: `.env`,
/// `.env.*` (but not templates such as `.env.example`), keys and certificates, `id_*`
/// private keys, `credentials*`, `secrets*`, `.npmrc`, `.netrc`, `*.tfvars`, or anything
/// under `.aws/` or `.ssh/`.
#[must_use]
pub fn secret_path(path: &str) -> bool {
    let path = path.trim().trim_matches(['"', '\'']);
    let mut parts = path.split(['/', '\\']).filter(|p| !p.is_empty());
    let Some(name) = parts.next_back() else {
        return false;
    };
    if path
        .split(['/', '\\'])
        .any(|part| matches!(part, ".aws" | ".ssh"))
    {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    if template_name(&lower) {
        return false;
    }
    lower.starts_with(".env")
        || [".pem", ".key", ".p12", ".pfx", ".tfvars"]
            .iter()
            .any(|ext| lower.ends_with(ext))
        || (lower.starts_with("id_") && !lower.contains('.'))
        || lower.starts_with("credentials")
        || lower.starts_with("secrets")
        || matches!(lower.as_str(), ".npmrc" | ".netrc")
}

/// Whether a short-flag cluster (`-uH`, not `--long`) holds any of `flags`.
fn short_flag(word: &str, flags: &[char]) -> bool {
    word.strip_prefix('-')
        .filter(|rest| !rest.starts_with('-'))
        .is_some_and(|rest| rest.chars().any(|c| flags.contains(&c)))
}

/// Whether one shell command (no separators) searches hidden or ignored files: ripgrep or
/// ag with hidden or unrestricted flags, fd with hidden or no-ignore flags, or a recursive
/// grep that doesn't exclude secret files (`--exclude=.env*` and the like).
fn searches_hidden(words: &[&str]) -> bool {
    let program = words.first().map(|w| w.rsplit('/').next().unwrap_or(w));
    let long = |names: &[&str]| words.iter().any(|w| names.contains(w));
    match program {
        Some("rg") => {
            long(&[
                "--hidden",
                "--no-ignore",
                "--unrestricted",
                "--no-ignore-vcs",
            ]) || words.iter().any(|w| short_flag(w, &['u', '.']))
        }
        Some("ag") => {
            long(&[
                "--hidden",
                "--unrestricted",
                "--skip-vcs-ignores",
                "--all-types",
            ]) || words.iter().any(|w| short_flag(w, &['u', 'U']))
        }
        Some("fd" | "fdfind") => {
            long(&["--hidden", "--no-ignore", "--unrestricted"])
                || words.iter().any(|w| short_flag(w, &['H', 'I', 'u']))
        }
        Some("grep" | "egrep" | "fgrep") => {
            let recursive = long(&["--recursive", "--dereference-recursive"])
                || words.iter().any(|w| short_flag(w, &['r', 'R']));
            let excludes_secrets = words.windows(2).any(|pair| {
                let value = match pair[0].strip_prefix("--exclude=") {
                    Some(value) => value,
                    None if pair[0] == "--exclude" => pair[1],
                    None => return false,
                };
                secret_path(value.trim_matches(['"', '\'']))
            }) || words
                .last()
                .and_then(|w| w.strip_prefix("--exclude="))
                .is_some_and(secret_path);
            recursive && !excludes_secrets
        }
        _ => false,
    }
}

/// Best effort: a shell command that names a secret file outside `ls`, `test` or `git
/// check-ignore`, or searches hidden or ignored files. Quoting, variables and
/// substitutions can hide a path from this check.
fn secret_command(command: &str) -> bool {
    command
        .split(['\n', ';', '|', '&', '(', ')', '`'])
        .map(|segment| {
            segment
                .split(|c: char| c.is_whitespace() || c == '<' || c == '>')
                .map(|w| w.trim_matches(['"', '\'']))
                .filter(|w| !w.is_empty())
                .collect::<Vec<_>>()
        })
        .any(|words| {
            let program = words.first().map(|w| w.rsplit('/').next().unwrap_or(w));
            let existence_only = matches!(program, Some("ls" | "test" | "["))
                || (program == Some("git") && words.get(1) == Some(&"check-ignore"));
            searches_hidden(&words)
                || (!existence_only
                    && words.iter().enumerate().any(|(i, w)| {
                        // Excluding secrets from a search names them without reading them.
                        let excluding = w.starts_with("--exclude")
                            || w.starts_with("--glob=!")
                            || (i > 0 && matches!(words[i - 1], "--exclude" | "--exclude-dir"));
                        !excluding
                            && (secret_path(w)
                                || w.split_once('=')
                                    .is_some_and(|(_, value)| secret_path(value)))
                    }))
        })
}

/// Why a detection session's tool call is refused, if it reads, edits or searches a
/// secret file. File tools are checked by their path and glob fields; shell tools by
/// [`secret_command`].
fn secret_guard(input: &Value) -> Option<String> {
    let tool = input.get("tool_input")?;
    let field = |key: &str| tool.get(key).and_then(Value::as_str);
    let named = ["file_path", "path", "notebook_path", "glob"]
        .into_iter()
        .filter_map(field)
        .chain(
            (input.get("tool_name").and_then(Value::as_str) == Some("Glob"))
                .then(|| field("pattern"))
                .flatten(),
        )
        .find(|path| secret_path(path));
    if let Some(path) = named {
        return Some(format!(
            "Patchbay blocks run & test detection from reading secret files ({path}). Learn \
             that it exists from ls or git check-ignore only, and read .env.example-style \
             templates for variable names."
        ));
    }
    // Codex can pass argv as an array.
    let command = match tool.get("command") {
        Some(Value::String(c)) => c.clone(),
        Some(Value::Array(words)) => words
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    secret_command(&command).then(|| {
        "Patchbay blocks run & test detection from reading or searching secret files \
         (.env, keys, credentials) and hidden or ignored files. Learn that a secret file \
         exists from ls or git check-ignore only."
            .to_string()
    })
}

/// A `PreToolUse` refusal with `reason`, which both providers take.
fn deny_output(reason: &str) -> Value {
    json!({"hookSpecificOutput":{
        "hookEventName":"PreToolUse",
        "permissionDecision":"deny",
        "permissionDecisionReason":reason,
    }})
}

/// What a planner's hook event says about Claude's native plan dialog.
#[derive(Debug, PartialEq, Eq)]
enum PlanSignal<'a> {
    /// `ExitPlanMode` shows the plan for approval.
    Presented(&'a str),
    /// The user approved it.
    Approved(&'a str),
    /// The turn went on, so an open dialog closed without approval.
    Moved,
}

/// Claude injects the native plan before presenting its approval dialog. Capture
/// text directly, without opening provider-supplied paths or approving the tool.
fn plan_signal(provider: Adapter, input: &Value) -> Option<PlanSignal<'_>> {
    if provider != Adapter::Claude
        || input
            .get("agent_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        || !crate::adapters::valid_id(input.get("session_id")?.as_str()?)
    {
        return None;
    }
    let plan = |field: &str| {
        input
            .get(field)?
            .get("plan")?
            .as_str()
            .filter(|plan| !plan.trim().is_empty() && plan.len() <= crate::plans::PLAN_LIMIT)
    };
    let exit_plan = input.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode");
    match input.get("hook_event_name")?.as_str()? {
        "PreToolUse" | "PermissionRequest" if exit_plan => {
            plan("tool_input").map(PlanSignal::Presented)
        }
        "PostToolUse" if exit_plan => plan("tool_response").map(PlanSignal::Approved),
        // The dialog's own notification, and a new session, say nothing about it.
        "Notification" | "SessionStart" => None,
        _ => Some(PlanSignal::Moved),
    }
}

/// Hand a planner's native plan to the desktop, within the hook's own timeout. The
/// journal folder remembers a presented plan, so only this session's dialog is withdrawn.
fn hand_plan(dir: &Path, signal: PlanSignal<'_>, conversation: Option<String>) {
    use crate::agent_bridge::{Action, call_from_env_within};
    let presented = dir.join("plan-presented");
    let action = match signal {
        PlanSignal::Presented(plan) => {
            let _ = std::fs::write(&presented, b"");
            Action::SavePlan {
                plan: plan.into(),
                conversation,
                presented: true,
            }
        }
        PlanSignal::Approved(plan) => {
            let _ = std::fs::remove_file(&presented);
            Action::SavePlan {
                plan: plan.into(),
                conversation,
                presented: false,
            }
        }
        PlanSignal::Moved => {
            if std::fs::remove_file(&presented).is_err() {
                return;
            }
            Action::WithdrawPlan { conversation }
        }
    };
    // The bridge's launch capability fixes the project/task and rejects non-planners.
    // An unavailable or slow desktop must never block Claude.
    let _ = call_from_env_within(action, std::time::Duration::from_secs(1));
}

/// Isolate and bound provider payloads. Ignore subagents and unrelated notifications.
fn normalize(provider: Adapter, input: &Value) -> Option<HookEvent> {
    let event = input.get("hook_event_name")?.as_str()?;
    if input
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return None;
    }
    let supported = EVENTS.contains(&event)
        || (provider == Adapter::Codex && event == "Interrupt")
        || (provider == Adapter::Claude
            && matches!(
                event,
                "Notification"
                    | "StopFailure"
                    | "PostToolUseFailure"
                    | "PreCompact"
                    | "PostCompact"
            ));
    if !supported {
        return None;
    }
    if event == "Notification"
        && input.get("notification_type").and_then(Value::as_str) != Some("permission_prompt")
    {
        return None;
    }
    let conversation = input.get("session_id")?.as_str()?;
    if !crate::adapters::valid_id(conversation) {
        return None;
    }
    let field = |name: &str| {
        input
            .get(name)
            .and_then(Value::as_str)
            .map(|s| s.chars().take(200).collect())
    };
    let turn = input
        .get("turn_id")
        .or_else(|| input.get("prompt_id"))
        .and_then(Value::as_str)
        .filter(|id| crate::adapters::valid_id(id))
        .map(str::to_string);
    // Older providers without turn identity retain Active/Quiet fallback.
    if !matches!(
        event,
        "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PreCompact" | "PostCompact"
    ) && turn.is_none()
    {
        return None;
    }
    let file_path = input.get("tool_input").and_then(|tool| {
        tool.get("file_path")
            .and_then(Value::as_str)
            .or_else(|| tool.get("path").and_then(Value::as_str))
            .or_else(|| {
                (input.get("tool_name").and_then(Value::as_str) == Some("apply_patch"))
                    .then(|| patched_file(tool))
                    .flatten()
            })
    });
    Some(HookEvent {
        session: String::new(),
        generation: 0,
        provider,
        sequence: 0,
        at_ms: crate::pty::now_ms(),
        event: event.into(),
        conversation: conversation.into(),
        turn,
        prompt: field("prompt"),
        source: field("source"),
        tool: field("tool_name").map(|name: String| match name.as_str() {
            "exec_command" | "shell_command" | "shell" => "Bash".into(),
            "apply_patch" => "Edit".into(),
            "read_file" => "Read".into(),
            "write_file" => "Write".into(),
            "edit_file" => "Edit".into(),
            "request_user_input" | "request_user_input_async" => "AskUserQuestion".into(),
            _ => name,
        }),
        file_target: file_path.is_some(),
        usage_limit: event == "StopFailure"
            && matches!(
                input.get("error").and_then(Value::as_str),
                Some("rate_limit" | "billing_error")
            ),
        questions: (event == "PreToolUse").then(|| questions(input)).flatten(),
        target: file_path
            .map(|s| s.chars().take(4096).collect())
            .or_else(|| {
                input
                    .get("tool_input")?
                    .get("command")?
                    .as_str()
                    .map(|s| s.chars().take(120).collect())
            }),
        reply: (event == "Stop")
            .then(|| {
                let text = input.get("last_assistant_message")?.as_str()?;
                let mut end = text.len().min(REPLY_LIMIT);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                (!text[..end].trim().is_empty()).then(|| text[..end].to_owned())
            })
            .flatten(),
        message: field("message")
            .or_else(|| {
                input
                    .get("tool_input")?
                    .get("questions")?
                    .as_array()?
                    .first()
                    .and_then(question_text)
                    .map(|s| s.chars().take(200).collect())
            })
            .or_else(|| {
                input
                    .get("tool_input")
                    .and_then(|v| v.get("description"))
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(200).collect())
            }),
    })
}

/// The one file a Codex `apply_patch` names in its `*** Add/Update/Delete File:` (and `*** Move
/// to:`) headers, which the patch grammar puts at the start of a line, where hunk lines (` `, `+`,
/// `-`, `@@`) can't. A patch naming several files, or none, has no single file target; nothing else
/// in its body is ever read as a path.
fn patched_file(tool: &Value) -> Option<&str> {
    let patch = ["patch", "input", "command"]
        .iter()
        .find_map(|name| tool.get(name).and_then(Value::as_str))?;
    let mut file = None;
    for line in patch.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(path) = [
            "*** Add File: ",
            "*** Update File: ",
            "*** Delete File: ",
            "*** Move to: ",
        ]
        .iter()
        .find_map(|header| line.strip_prefix(header))
        .map(str::trim) else {
            continue;
        };
        if path.is_empty() || file.is_some_and(|f| f != path) {
            return None;
        }
        file = Some(path);
    }
    file
}

/// Called by packaged sessiond before daemon initialization. Always silent and fail-open.
pub fn reporter(provider: &str) {
    let _ = (|| -> Result<()> {
        let provider = match provider {
            "claude" => Adapter::Claude,
            "codex" => Adapter::Codex,
            _ => return Ok(()),
        };
        let invoked_ms = crate::pty::now_ms();
        let guarded = std::env::var(SECRET_GUARD_ENV).ok().as_deref() == Some("1");
        let ours = std::env::var(PROVIDER_ENV).ok().as_deref() == Some(provider_name(provider));
        if !ours && !guarded {
            return Ok(());
        }
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Ok(());
        }
        let input: Value = serde_json::from_slice(&bytes)?;
        // Before anything that needs the journal: the guard holds even without status reporting.
        if guarded
            && input.get("hook_event_name").and_then(Value::as_str) == Some("PreToolUse")
            && let Some(reason) = secret_guard(&input)
        {
            let mut stdout = std::io::stdout().lock();
            serde_json::to_writer(&mut stdout, &deny_output(&reason))?;
            stdout.flush()?;
            return Ok(());
        }
        if !ours {
            return Ok(());
        }
        let Some(session) = std::env::var(SESSION_ENV).ok().filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        let Some(generation) = std::env::var(GENERATION_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
        else {
            return Ok(());
        };
        let Some(dir) = std::env::var_os(JOURNAL_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        else {
            return Ok(());
        };
        let meta = std::fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Ok(());
        }
        let mut asked = None;
        let mut approval = None;
        if let Some(mut event) = normalize(provider, &input) {
            event.at_ms = invoked_ms;
            event.session = session;
            event.generation = generation;
            let questions = event.questions.clone();
            let permission = (event.event == "PermissionRequest").then(|| event.clone());
            // Status first: handing over a plan or a question waits on the desktop,
            // and Chat shows a question from the reported status.
            if journal(&dir, event).is_ok() {
                asked = questions;
                approval = permission;
            }
        }
        if let Some(mut decided) = approval
            && let Some(output) = ask_permission_in_chat(provider, &input)
        {
            // The answer ends the input wait; no provider hook reports that until the
            // tool finishes.
            decided.event = PERMISSION_DECIDED.into();
            decided.at_ms = crate::pty::now_ms();
            decided.message = None;
            let _ = journal(&dir, decided);
            let mut stdout = std::io::stdout().lock();
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.flush()?;
            return Ok(());
        }
        if let Some(questions) = asked {
            if let Some(output) = ask_in_chat(provider, &input, questions) {
                let mut stdout = std::io::stdout().lock();
                serde_json::to_writer(&mut stdout, &output)?;
                stdout.flush()?;
            }
            return Ok(());
        }
        // Plans are captured even when older Claude versions omit turn identity.
        if std::env::var(crate::context::COMPONENT_ENV).ok().as_deref() == Some("plan")
            && let Some(signal) = plan_signal(provider, &input)
        {
            let conversation = input.get("session_id").and_then(Value::as_str);
            hand_plan(&dir, signal, conversation.map(Into::into));
        }
        Ok(())
    })();
}

/// Append `event` to the session's journal, in sequence.
fn journal(dir: &Path, mut event: HookEvent) -> Result<()> {
    // Serialize commits so the monitor can consume prompt/progress/completion in order.
    let lock = crate::workspace::lock(&dir.join("report.lock"))?;
    let mut locked = false;
    for _ in 0..100 {
        if lock.try_lock().is_ok() {
            locked = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !locked {
        return Ok(());
    }
    let counter = dir.join("sequence");
    let previous = std::fs::read_to_string(&counter)
        .unwrap_or_default()
        .parse::<u64>()
        .unwrap_or(0);
    event.sequence = previous
        .checked_add(1)
        .context("Reporter sequence exhausted")?;
    atomic_replace(&counter, event.sequence.to_string().as_bytes(), false)?;
    atomic_replace(
        &dir.join(format!("{:020}.json", event.sequence)),
        &serde_json::to_vec(&event)?,
        false,
    )?;
    Ok(())
}

/// Bytes of a final assistant message relayed with `Stop`; the plan itself travels as a file.
pub const REPLY_LIMIT: usize = 16 * 1024;
/// Largest journal entry `drain` reads: a reply escaped at worst six bytes per byte
/// (`\u001f`), plus room for the other fields, so no `Stop` is ever dropped for its size.
const ENTRY_LIMIT: usize = 6 * REPLY_LIMIT + 64 * 1024;

/// Read committed events, ordered and consumed once. Called under the tracker lock.
pub(crate) fn drain(dir: &Path) -> Vec<HookEvent> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .take(256)
        .filter_map(|path| {
            let event = std::fs::read(&path)
                .ok()
                .filter(|b| b.len() <= ENTRY_LIMIT)
                .and_then(|b| serde_json::from_slice(&b).ok());
            let _ = std::fs::remove_file(path);
            event
        })
        .collect()
}

fn provider_name(provider: Adapter) -> &'static str {
    match provider {
        Adapter::Claude => "claude",
        Adapter::Codex => "codex",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub provider: Adapter,
    pub source: String,
    pub default_source: Option<String>,
    pub reporter: String,
    pub installed: bool,
    pub disabled: bool,
    pub reporter_available: bool,
    pub reporting_sessions: usize,
    pub guidance: Vec<String>,
}

/// Effective inherited user directory, including provider overrides.
///
/// # Errors
/// Fails for relative override directories or missing home.
pub fn user_source(provider: Adapter) -> Result<PathBuf> {
    let dir = user_dir(provider)?;
    if provider == Adapter::Codex {
        return codex_source(&dir);
    }
    Ok(dir.join("settings.json"))
}

/// The provider's effective user directory (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` or the default),
/// without reading any configuration in it.
///
/// # Errors
/// Fails for relative override directories or missing home.
pub(crate) fn user_dir(provider: Adapter) -> Result<PathBuf> {
    let home = dirs::home_dir().context("No home directory")?;
    let (variable, default) = match provider {
        Adapter::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
        Adapter::Codex => ("CODEX_HOME", ".codex"),
    };
    let dir = std::env::var_os(variable).map_or_else(|| home.join(default), PathBuf::from);
    anyhow::ensure!(dir.is_absolute(), "{variable} must be absolute");
    Ok(dir)
}

// Codex persists trust in config.toml even when definitions live in hooks.json.
fn codex_hook_metadata(name: &str) -> bool {
    matches!(name, "state" | "managed_dir" | "windows_managed_dir")
}

fn codex_source(dir: &Path) -> Result<PathBuf> {
    let path = dir.join("config.toml");
    let text = read_optional(&path)?;
    if !text.is_empty() {
        let doc = text
            .parse::<toml_edit::DocumentMut>()
            .context("Malformed Codex config.toml; no changes made")?;
        if let Some(hooks) = doc.get("hooks") {
            // Keep malformed definitions on the validation path, rather than
            // silently falling back to a different configuration file.
            if hooks
                .as_table_like()
                .is_none_or(|table| table.iter().any(|(name, _)| !codex_hook_metadata(name)))
            {
                return Ok(path);
            }
        }
    }
    Ok(dir.join("hooks.json"))
}

pub(crate) fn stable_reporter() -> Result<PathBuf> {
    Ok(crate::workspace::home()?
        .join("reporters")
        .join(if cfg!(windows) {
            "patchbay-status-v1.exe"
        } else {
            "patchbay-status-v1"
        }))
}

pub(crate) fn read_optional(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn read_json(path: &Path, provider: Adapter) -> Result<Value> {
    let text = read_optional(path)?;
    let value = if text.is_empty() {
        anyhow::ensure!(
            !path.exists(),
            "Empty provider JSON configuration is malformed; no changes made"
        );
        json!({})
    } else {
        serde_json::from_str(&text).context("Malformed provider configuration; no changes made")?
    };
    validate_shape(&value, provider)?;
    Ok(value)
}
fn validate_shape(value: &Value, provider: Adapter) -> Result<()> {
    anyhow::ensure!(
        value.is_object(),
        "Provider configuration must be an object"
    );
    if let Some(hooks) = value.get("hooks") {
        let hooks = hooks
            .as_object()
            .context("Malformed hooks: expected object")?;
        for (name, groups) in hooks {
            if provider == Adapter::Codex && codex_hook_metadata(name) {
                if name == "state" {
                    anyhow::ensure!(groups.is_object(), "Malformed hook state: expected object");
                } else {
                    anyhow::ensure!(groups.is_string(), "Malformed managed hook directory");
                }
                continue;
            }
            for group in groups
                .as_array()
                .context("Malformed hooks: expected matcher array")?
            {
                anyhow::ensure!(group.is_object(), "Malformed hook matcher");
                let handlers = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .context("Malformed hook handlers")?;
                anyhow::ensure!(
                    handlers.iter().all(Value::is_object),
                    "Malformed hook handler"
                );
            }
        }
    }
    Ok(())
}
fn owned(handler_value: &Value, provider: Adapter, reporter: &Path) -> bool {
    let Ok(expected) = handler(provider, reporter) else {
        return false;
    };
    ["type", "command", "args", "statusMessage"]
        .iter()
        .all(|key| handler_value.get(key) == expected.get(key))
}
fn handler(provider: Adapter, reporter: &Path) -> Result<Value> {
    let path = reporter.to_str().context("Reporter path must be UTF-8")?;
    Ok(match provider {
        Adapter::Claude => {
            json!({"type":"command", "command": path, "args":["report-status", "claude"], "timeout": HOOK_TIMEOUT, "statusMessage":MARKER})
        }
        Adapter::Codex => {
            // Codex command hooks use a shell. Windows launches through PowerShell explicitly.
            let command = if cfg!(windows) {
                let quoted = format!("& '{}' report-status codex", path.replace('\'', "''"));
                use base64::Engine;
                let bytes: Vec<_> = quoted.encode_utf16().flat_map(u16::to_le_bytes).collect();
                format!(
                    "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            } else {
                format!("'{}' report-status codex", path.replace('\'', "'\\''"))
            };
            json!({"type":"command", "command":command, "timeout":HOOK_TIMEOUT, "statusMessage":MARKER})
        }
    })
}

/// The handler installed for `event`, with that event's timeout.
fn event_handler(provider: Adapter, reporter: &Path, event: &str) -> Result<Value> {
    let mut value = handler(provider, reporter)?;
    value["timeout"] = json!(hook_timeout(event));
    Ok(value)
}

fn events(provider: Adapter) -> Vec<&'static str> {
    let mut events = EVENTS.to_vec();
    match provider {
        Adapter::Claude => events.extend([
            "Notification",
            "StopFailure",
            "PostToolUseFailure",
            "PreCompact",
            "PostCompact",
        ]),
        Adapter::Codex => events.push("Interrupt"),
    }
    events
}
fn json_update(
    mut value: Value,
    provider: Adapter,
    reporter: &Path,
    install: bool,
) -> Result<Value> {
    validate_shape(&value, provider)?;
    if value.get("hooks").is_none() && !install {
        return Ok(value);
    }
    let hooks = value
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap();
    for groups in hooks.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        groups.retain_mut(|group| {
            let handlers = group["hooks"].as_array_mut().unwrap();
            let before = handlers.len();
            handlers.retain(|h| !owned(h, provider, reporter));
            !handlers.is_empty() || before == 0
        });
    }
    if install {
        for event in events(provider) {
            hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(json!({"hooks":[event_handler(provider, reporter, event)?]}));
        }
    }
    Ok(value)
}

// Preserve unrelated TOML text verbatim. Only event tables affected by installation
// or an exactly owned handler are rewritten; inline arrays are supported too.
fn toml_update(text: &str, provider: Adapter, reporter: &Path, install: bool) -> Result<String> {
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .context("Malformed Codex TOML; no changes made")?;
    let raw: toml::Value = toml::from_str(text)?;
    let value = serde_json::to_value(raw)?;
    validate_shape(&value, provider)?;
    let updated = json_update(value.clone(), provider, reporter, install)?;
    let Some(updated_hooks) = updated.get("hooks").and_then(Value::as_object) else {
        return Ok(doc.to_string());
    };
    // Convert an inline hooks root only when it needs modification.
    if !doc.get("hooks").is_some_and(toml_edit::Item::is_table) {
        if !install && value.get("hooks") == updated.get("hooks") {
            return Ok(doc.to_string());
        }
        let toml_value: toml::Value = serde_json::from_value(json!({"hooks":updated_hooks}))?;
        let generated = toml::to_string(&toml_value)?.parse::<toml_edit::DocumentMut>()?;
        doc["hooks"] = generated["hooks"].clone();
        return Ok(doc.to_string());
    }
    for (event, groups) in updated_hooks {
        if value.get("hooks").and_then(|h| h.get(event)) == Some(groups) {
            continue;
        }
        let toml_value: toml::Value = serde_json::from_value(json!({"hooks":{event:groups}}))?;
        let generated = toml::to_string(&toml_value)?.parse::<toml_edit::DocumentMut>()?;
        doc["hooks"][event] = generated["hooks"][event].clone();
    }
    Ok(doc.to_string())
}

/// Check configuration only. Installed does not imply trusted or reporting.
///
/// # Errors
/// Fails for malformed or inaccessible effective user configuration.
pub fn inspect(provider: Adapter, source_override: Option<&Path>) -> Result<Integration> {
    let path = source_override.map_or_else(|| user_source(provider), |p| Ok(p.to_owned()))?;
    anyhow::ensure!(path.is_absolute(), "Hook source must be absolute");
    let value = if path.extension().is_some_and(|e| e == "toml") {
        serde_json::to_value(toml::from_str::<toml::Value>(&read_optional(&path)?)?)?
    } else {
        read_json(&path, provider)?
    };
    validate_shape(&value, provider)?;
    let installed = events(provider).iter().all(|event| {
        value
            .get("hooks")
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().any(|g| {
                    g.get("hooks").and_then(Value::as_array).is_some_and(|hs| {
                        // An older install's short PreToolUse timeout would cut off
                        // a question waiting for its Chat answer: reinstall it.
                        hs.iter().any(|h| {
                            owned(h, provider, &stable_reporter().unwrap_or_default())
                                && h.get("timeout").and_then(Value::as_u64)
                                    == Some(hook_timeout(event))
                        })
                    })
                })
            })
    });
    let mut disabled = value.get("disableAllHooks").and_then(Value::as_bool) == Some(true);
    if provider == Adapter::Codex {
        let config = if path.extension().is_some_and(|e| e == "toml") {
            read_optional(&path)?
        } else {
            read_optional(&path.with_file_name("config.toml"))?
        };
        let config: toml::Value =
            toml::from_str(&config).context("Malformed Codex user config; no changes made")?;
        let features = config.get("features");
        disabled |= features
            .and_then(|f| f.get("hooks"))
            .or_else(|| features.and_then(|f| f.get("codex_hooks")))
            .and_then(toml::Value::as_bool)
            == Some(false);
    }
    let mut guidance = vec!["Configuration inspection cannot establish active provider trust or effective project/managed policy. Start a Patchbay agent session to confirm reporting.".into()];
    if provider == Adapter::Codex {
        guidance.push("In Codex run /hooks to review and trust the Patchbay definitions. Disabled hooks and managed-only policy remain respected; Patchbay never bypasses trust.".into());
    }
    if provider == Adapter::Claude {
        guidance.push("Claude user hooks require the user settings source to remain enabled. Existing --settings, --setting-sources, project settings and managed policy can disable them; Patchbay preserves these options.".into());
    }
    if disabled {
        guidance.push(
            "Hooks are disabled in this source. Installation will preserve that setting.".into(),
        );
    }
    Ok(Integration {
        provider,
        source: path.display().to_string(),
        default_source: user_source(provider).ok().map(|p| p.display().to_string()),
        reporter: stable_reporter()?.display().to_string(),
        installed,
        disabled,
        reporter_available: stable_reporter()?.is_file(),
        reporting_sessions: 0,
        guidance,
    })
}

/// Append or remove only Patchbay-owned handlers. Writes atomically under a local edit lock.
///
/// # Errors
/// Fails for malformed config, changed config,
/// symlinks, missing packaged helper, or filesystem errors. No trust changes.
pub fn configure(
    provider: Adapter,
    source_override: Option<&Path>,
    helper: &Path,
    install: bool,
) -> Result<Integration> {
    let source = source_override.map_or_else(|| user_source(provider), |p| Ok(p.to_owned()))?;
    anyhow::ensure!(source.is_absolute(), "Hook source must be absolute");
    let _lock = setup_lock()?;
    inspect(provider, Some(&source))?;
    let before = read_optional(&source)?;
    let reporter = stable_reporter()?;
    let bytes = if source.extension().is_some_and(|s| s == "toml") {
        toml_update(&before, provider, &reporter, install)?.into_bytes()
    } else {
        let value = read_json(&source, provider)?;
        serde_json::to_vec_pretty(&json_update(value, provider, &reporter, install)?)?
    };
    // Validate configuration before deploying the helper or changing its source.
    if install {
        deploy_helper(helper, &reporter)?;
    }
    anyhow::ensure!(
        read_optional(&source)? == before,
        "Provider configuration changed during setup; check integration and retry"
    );
    if install || !before.is_empty() {
        atomic_replace(&source, &bytes, false)?;
    }
    inspect(provider, Some(&source))
}

pub(crate) fn setup_lock() -> Result<std::fs::File> {
    let state = crate::workspace::home()?.join("reporters");
    crate::workspace::private_dir(&state)?;
    let lock = crate::workspace::lock(&state.join("setup.lock"))?;
    lock.lock()?;
    Ok(lock)
}

pub(crate) fn deploy_helper(helper: &Path, reporter: &Path) -> Result<()> {
    anyhow::ensure!(
        helper.is_file(),
        "Packaged status reporter is missing. Reinstall or rebuild Patchbay."
    );
    atomic_replace(reporter, &std::fs::read(helper)?, true)
}

/// Atomic replacement without changing provider directory permissions.
pub(crate) fn atomic_replace(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        anyhow::ensure!(
            !meta.file_type().is_symlink() && meta.is_file(),
            "Refusing to replace symlink/non-file {}",
            path.display()
        );
    }
    let parent = path.parent().context("Missing source parent")?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".patchbay-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        if let Ok(meta) = std::fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_native_plans_before_approval_and_uses_approved_response() {
        let mut input = json!({
            "hook_event_name":"PreToolUse", "session_id":"12345678-session",
            "tool_name":"ExitPlanMode", "tool_input":{"plan":"# Proposed plan"}
        });
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Presented("# Proposed plan"))
        );
        // Capture still works when older providers omit turn identity.
        assert!(normalize(Adapter::Claude, &input).is_none());
        input["hook_event_name"] = json!("PermissionRequest");
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Presented("# Proposed plan"))
        );
        input["hook_event_name"] = json!("PostToolUse");
        input["tool_response"] = json!({"plan":"# Approved revision", "filePath":"/ignored"});
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Approved("# Approved revision"))
        );
        assert!(plan_signal(Adapter::Codex, &input).is_none());
        input["agent_id"] = json!("child");
        assert!(plan_signal(Adapter::Claude, &input).is_none());
    }

    #[test]
    fn a_turn_that_goes_on_withdraws_and_paths_or_invalid_plans_are_ignored() {
        let mut input = json!({
            "hook_event_name":"PreToolUse", "session_id":"12345678-session",
            "tool_name":"ExitPlanMode", "tool_input":{"planFilePath":"/private/plan.md"}
        });
        assert!(plan_signal(Adapter::Claude, &input).is_none());
        for plan in [" ".to_string(), "x".repeat(crate::plans::PLAN_LIMIT + 1)] {
            input["tool_input"]["plan"] = json!(plan);
            assert!(plan_signal(Adapter::Claude, &input).is_none());
        }
        input["tool_input"]["plan"] = json!("# Plan");
        // A rejected plan: the dialog's notification says nothing, the turn going on does.
        input["hook_event_name"] = json!("Notification");
        assert!(plan_signal(Adapter::Claude, &input).is_none());
        input["hook_event_name"] = json!("PostToolUseFailure");
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Moved)
        );
        input["hook_event_name"] = json!("PreToolUse");
        input["tool_name"] = json!("Write");
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Moved)
        );
        input["hook_event_name"] = json!("Stop");
        assert_eq!(
            plan_signal(Adapter::Claude, &input),
            Some(PlanSignal::Moved)
        );
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-hooks-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn a_longest_escaped_reply_survives_the_journal() {
        let fixture = Fixture::new();
        let input = json!({"hook_event_name":"Stop", "session_id":"12345678-session", "turn_id":"12345678-turn", "last_assistant_message":"\u{1}".repeat(REPLY_LIMIT * 2)});
        let mut event = normalize(Adapter::Claude, &input).unwrap();
        event.target = Some("界".repeat(4096));
        journal(&fixture.0, event).unwrap();
        let drained = drain(&fixture.0);
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].reply.as_ref().unwrap().len(), REPLY_LIMIT);
    }
    #[test]
    fn codex_uses_json_when_toml_contains_only_hook_metadata() {
        let fixture = Fixture::new();
        let config = fixture.0.join("config.toml");
        let hooks = fixture.0.join("hooks.json");
        assert_eq!(codex_source(&fixture.0).unwrap(), hooks);
        for text in [
            "model = 'user-model'\n",
            "[hooks]\n",
            "[hooks.state]\n",
            "[hooks.state.'user/hooks.json:stop:0:0']\ntrusted_hash = 'keep-me'\nenabled = false\n",
            "[hooks]\nmanaged_dir = '/managed/hooks'\nwindows_managed_dir = 'C:\\managed'\n",
        ] {
            std::fs::write(&config, text).unwrap();
            assert_eq!(codex_source(&fixture.0).unwrap(), hooks, "{text}");
            // Choosing JSON and updating its definitions leaves TOML trust untouched.
            let installed = json_update(
                json!({}),
                Adapter::Codex,
                Path::new("/tmp/patchbay-status-v1"),
                true,
            )
            .unwrap();
            std::fs::write(&hooks, serde_json::to_vec(&installed).unwrap()).unwrap();
            assert!(inspect(Adapter::Codex, Some(&hooks)).is_ok());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
        }
        for text in [
            "[hooks]\nStop = []\n[hooks.state]\n",
            "hooks = { Stop = [], state = {} }\n",
            "[hooks]\nStop = false\n",
            "hooks = false\n",
        ] {
            std::fs::write(&config, text).unwrap();
            assert_eq!(codex_source(&fixture.0).unwrap(), config, "{text}");
        }
    }

    #[test]
    fn codex_inline_install_and_remove_preserve_hook_trust_state() {
        let fixture = Fixture::new();
        let config = fixture.0.join("config.toml");
        let reporter = stable_reporter().unwrap();
        let trust = "# keep trust records verbatim\n[hooks.state.'user/hooks.json:stop:0:0']\ntrusted_hash = 'keep-me'\nenabled = false\n";
        let original = format!(
            "[hooks]\nStop = [{{ hooks = [{{ type = 'command', command = 'user-validation' }}] }}]\n{trust}"
        );
        std::fs::write(&config, &original).unwrap();
        assert_eq!(codex_source(&fixture.0).unwrap(), config);
        assert!(!inspect(Adapter::Codex, Some(&config)).unwrap().installed);
        let installed = toml_update(&original, Adapter::Codex, &reporter, true).unwrap();
        assert!(installed.contains(trust));
        assert_eq!(
            installed,
            toml_update(&installed, Adapter::Codex, &reporter, true).unwrap()
        );
        std::fs::write(&config, &installed).unwrap();
        assert!(inspect(Adapter::Codex, Some(&config)).unwrap().installed);
        let removed = toml_update(&installed, Adapter::Codex, &reporter, false).unwrap();
        assert!(removed.contains(trust));
        let value: toml::Value = toml::from_str(&removed).unwrap();
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            value["hooks"]["Stop"][0]["hooks"][0]["command"].as_str(),
            Some("user-validation")
        );
        std::fs::write(&config, &removed).unwrap();
        assert!(!inspect(Adapter::Codex, Some(&config)).unwrap().installed);
    }

    #[test]
    fn install_remove_preserve_user_settings_and_hooks_and_are_idempotent() {
        let reporter = Path::new("/some folder/a'punctuation/$literal/patchbay-status-v1");
        let original = json!({
            "model":"user-model", "disableAllHooks":true,
            "hooks":{"Stop":[{"matcher":".*","hooks":[{"type":"command","command":"user-validation"}]}],
                "Notification":[{"hooks":[]}]}
        });
        let installed = json_update(original.clone(), Adapter::Claude, reporter, true).unwrap();
        assert_eq!(installed["disableAllHooks"], true);
        assert_eq!(installed["hooks"]["Stop"][0], original["hooks"]["Stop"][0]);
        assert_eq!(
            installed,
            json_update(installed.clone(), Adapter::Claude, reporter, true).unwrap()
        );
        let removed = json_update(installed, Adapter::Claude, reporter, false).unwrap();
        assert_eq!(removed["model"], original["model"]);
        assert_eq!(removed["hooks"]["Stop"], original["hooks"]["Stop"]);
        assert_eq!(
            removed["hooks"]["Notification"],
            original["hooks"]["Notification"]
        );
        assert_eq!(
            removed,
            json_update(removed.clone(), Adapter::Claude, reporter, false).unwrap()
        );
    }
    #[test]
    fn ownership_requires_exact_command_and_arguments_and_keeps_edited_entries() {
        let reporter = Path::new("/tmp/patchbay-status-v1");
        let exact = handler(Adapter::Codex, reporter).unwrap();
        assert!(owned(&exact, Adapter::Codex, reporter));
        let mut lookalike = exact.clone();
        lookalike["command"] = json!("echo patchbay-status-v1 unrelated");
        assert!(!owned(&lookalike, Adapter::Codex, reporter));
        let mut changed = handler(Adapter::Claude, reporter).unwrap();
        changed["args"] = json!(["report-status", "claude", "user-option"]);
        assert!(!owned(&changed, Adapter::Claude, reporter));
        assert!(!owned(&exact, Adapter::Claude, reporter));
    }
    #[test]
    fn toml_preserves_unrelated_text_and_accepts_inline_arrays() {
        let reporter = Path::new("/tmp/patchbay-status-v1");
        for hooks in [
            "[hooks]\nStop = [{ hooks = [{ type = 'command', command = 'user-validation' }] }]\n",
            "[[hooks.Stop]]\nmatcher = '.*'\n[[hooks.Stop.hooks]]\ntype = 'command'\ncommand = 'user-validation'\n",
            "hooks = { Stop = [{ hooks = [{ type = 'command', command = 'user-validation' }] }] }\n",
        ] {
            let original = format!(
                "# user comment\nmodel = 'user-model'\n{hooks}\n[other]\n# keep this comment\noption = 'unchanged'\n"
            );
            let installed = toml_update(&original, Adapter::Codex, reporter, true).unwrap();
            assert!(installed.contains("# user comment\nmodel = 'user-model'"));
            assert!(installed.contains("# keep this comment\noption = 'unchanged'"));
            assert_eq!(
                installed,
                toml_update(&installed, Adapter::Codex, reporter, true).unwrap()
            );
            let removed = toml_update(&installed, Adapter::Codex, reporter, false).unwrap();
            let value: toml::Value = toml::from_str(&removed).unwrap();
            assert_eq!(
                value["hooks"]["Stop"][0]["hooks"][0]["command"].as_str(),
                Some("user-validation")
            );
            assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 1);
            assert!(removed.contains("# keep this comment\noption = 'unchanged'"));
        }
    }
    #[test]
    fn malformed_sources_return_errors_without_panics_or_writes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("settings.json");
        for text in [
            "{bad",
            "[]",
            "{\"hooks\":[]}",
            "{\"hooks\":{\"Stop\":true}}",
            "{\"hooks\":{\"Stop\":[{\"hooks\":null}]}}",
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(read_json(&path, Adapter::Claude).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
        // Hook metadata is Codex's alone; in Claude settings it is a malformed event.
        let state = json!({"hooks":{"state":{"x":{}},"managed_dir":"/etc/codex"}});
        assert!(validate_shape(&state, Adapter::Codex).is_ok());
        assert!(validate_shape(&state, Adapter::Claude).is_err());
        for text in [
            "hooks = false",
            "[hooks]\nStop = false",
            "[hooks]\nStop = [{ hooks = 12 }]",
            "[hooks]\nStop = [{ hooks = ['wrong'] }]",
            "[hooks]\nstate = false",
            "[hooks]\nstate = []",
            "bad = {",
        ] {
            assert!(
                toml_update(
                    text,
                    Adapter::Codex,
                    Path::new("/tmp/patchbay-status-v1"),
                    true
                )
                .is_err()
            );
        }
    }
    #[test]
    fn claude_stop_failures_report_only_account_limits() {
        for (error, expected) in [
            ("rate_limit", true),
            ("billing_error", true),
            ("server_error", false),
        ] {
            let input = json!({"hook_event_name":"StopFailure","session_id":"12345678-session",
                "prompt_id":"12345678-prompt","error":error});
            let event = normalize(Adapter::Claude, &input).unwrap();
            assert_eq!(event.usage_limit, expected, "{error}");
        }
    }

    #[test]
    fn normalizes_parent_turns_and_rejects_subagents_and_missing_identity() {
        let input = json!({"hook_event_name":"UserPromptSubmit", "session_id":"12345678-session", "turn_id":"12345678-turn", "prompt":"hello"});
        let event = normalize(Adapter::Codex, &input).unwrap();
        assert_eq!(event.turn.as_deref(), Some("12345678-turn"));
        let mut subagent = input.clone();
        subagent["agent_id"] = json!("child");
        assert!(normalize(Adapter::Codex, &subagent).is_none());
        subagent = input.clone();
        subagent["hook_event_name"] = json!("SubagentStop");
        assert!(normalize(Adapter::Codex, &subagent).is_none());
        let mut selected_agent = input.clone();
        selected_agent["agent_type"] = json!("custom-main-agent");
        assert!(normalize(Adapter::Claude, &selected_agent).is_some());
        let mut legacy = input.clone();
        legacy.as_object_mut().unwrap().remove("turn_id");
        assert!(normalize(Adapter::Codex, &legacy).unwrap().turn.is_none());
        legacy["prompt_id"] = json!("12345678-claude-prompt");
        assert!(normalize(Adapter::Claude, &legacy).is_some());
        legacy["hook_event_name"] = json!("Notification");
        legacy["notification_type"] = json!("idle_prompt");
        assert!(normalize(Adapter::Claude, &legacy).is_none());
    }
    #[test]
    fn atomic_replacement_preserves_permissions_and_cleans_temp_files() {
        let fixture = Fixture::new();
        let path = fixture.0.join("settings.json");
        std::fs::write(&path, "before").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        atomic_replace(&path, b"after", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"after");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
    #[test]
    fn codex_disabled_features_and_managed_directory_metadata_are_preserved() {
        let fixture = Fixture::new();
        let config = fixture.0.join("config.toml");
        let text = "[features]\nhooks = false\n[hooks]\nmanaged_dir = '/managed/hooks'\nwindows_managed_dir = 'C:\\managed'\n";
        std::fs::write(&config, text).unwrap();
        let changed = toml_update(
            text,
            Adapter::Codex,
            Path::new("/tmp/patchbay-status-v1"),
            true,
        )
        .unwrap();
        let value: toml::Value = toml::from_str(&changed).unwrap();
        assert_eq!(value["features"]["hooks"].as_bool(), Some(false));
        assert_eq!(
            value["hooks"]["managed_dir"].as_str(),
            Some("/managed/hooks")
        );
        assert!(inspect(Adapter::Codex, Some(&config)).unwrap().disabled);
        let hooks = fixture.0.join("hooks.json");
        std::fs::write(&hooks, "{}").unwrap();
        assert!(inspect(Adapter::Codex, Some(&hooks)).unwrap().disabled);
    }
    #[test]
    fn tool_activity_extracts_paths_without_inference_and_caps_unicode_commands() {
        for provider in [Adapter::Claude, Adapter::Codex] {
            let mut input = json!({"hook_event_name":"PreToolUse","session_id":"12345678-conversation","turn_id":"12345678-turn","tool_name":"Read","tool_input":{"file_path":"src/a.rs","path":"ignored","command":"ignored"}});
            let event = normalize(provider, &input).unwrap();
            assert_eq!(event.tool.as_deref(), Some("Read"));
            assert_eq!(event.target.as_deref(), Some("src/a.rs"));
            assert!(event.file_target);
            input["tool_input"] = json!({"path":"src/b.rs"});
            assert_eq!(
                normalize(provider, &input).unwrap().target.as_deref(),
                Some("src/b.rs")
            );
            input["tool_name"] = json!("exec_command");
            input["tool_input"] = json!({"command":"界🦀".repeat(100)});
            let event = normalize(provider, &input).unwrap();
            assert_eq!(event.tool.as_deref(), Some("Bash"));
            assert_eq!(event.target.unwrap().chars().count(), 120);
            assert!(!event.file_target);
            input["tool_name"] = json!("apply_patch");
            // One file named by the patch's headers is its target; hunk lines never are.
            input["tool_input"] = json!({"patch":"*** Begin Patch\r\n*** Update File: src/a.rs\r\n@@\r\n-*** Add File: b\r\n+*** Delete File: c\r\n *** Move to: d\r\n*** End Patch"});
            let event = normalize(provider, &input).unwrap();
            assert_eq!(event.tool.as_deref(), Some("Edit"));
            assert_eq!(event.target.as_deref(), Some("src/a.rs"));
            assert!(event.file_target);
            input["tool_input"] = json!({"command":"*** Begin Patch\n*** Add File: src/new.rs\n+fn main() {}\n*** End Patch"});
            let event = normalize(provider, &input).unwrap();
            assert_eq!(event.target.as_deref(), Some("src/new.rs"));
            assert!(event.file_target);
            // Several files (a rename too) or none give no file target.
            for patch in [
                "*** Update File: src/a.rs\n*** Delete File: src/b.rs",
                "*** Update File: src/a.rs\n*** Move to: src/b.rs",
                "*** Add File: \n+x",
                "src/a.rs",
            ] {
                input["tool_input"] = json!({ "patch": patch });
                let event = normalize(provider, &input).unwrap();
                assert_eq!(event.target, None, "{patch}");
                assert!(!event.file_target, "{patch}");
            }
            input["tool_name"] = json!("Edit");
            input["tool_input"] = json!({"patch":"*** Update File: src/a.rs"});
            assert!(!normalize(provider, &input).unwrap().file_target);
            for (codex, tool) in [
                ("read_file", "Read"),
                ("write_file", "Write"),
                ("edit_file", "Edit"),
            ] {
                input["tool_name"] = json!(codex);
                input["tool_input"] = json!({"path":"src/c.rs"});
                let event = normalize(provider, &input).unwrap();
                assert_eq!(event.tool.as_deref(), Some(tool), "{codex}");
                assert_eq!(event.target.as_deref(), Some("src/c.rs"));
                assert!(event.file_target);
            }
            input["tool_name"] = json!("apply_patch");
            input["tool_name"] = json!("未知".repeat(120));
            assert_eq!(
                normalize(provider, &input)
                    .unwrap()
                    .tool
                    .unwrap()
                    .chars()
                    .count(),
                200
            );
            input.as_object_mut().unwrap().remove("tool_name");
            input.as_object_mut().unwrap().remove("tool_input");
            let event = normalize(provider, &input).unwrap();
            assert_eq!(event.tool, None);
            assert_eq!(event.target, None);
            let mut legacy = serde_json::to_value(event).unwrap();
            for field in ["tool", "target", "fileTarget"] {
                legacy.as_object_mut().unwrap().remove(field);
            }
            assert!(serde_json::from_value::<HookEvent>(legacy).is_ok());
        }
    }
    #[test]
    fn stop_relays_only_text_replies_capped_at_a_character_boundary() {
        for provider in [Adapter::Claude, Adapter::Codex] {
            let mut input = json!({"hook_event_name":"Stop", "session_id":"12345678-session", "turn_id":"12345678-turn", "last_assistant_message":"Hello **world**"});
            assert_eq!(
                normalize(provider, &input).unwrap().reply.as_deref(),
                Some("Hello **world**")
            );
            input["last_assistant_message"] = json!("界".repeat(REPLY_LIMIT));
            let reply = normalize(provider, &input).unwrap().reply.unwrap();
            assert_eq!(reply.len(), REPLY_LIMIT / 3 * 3);
            input["last_assistant_message"] = json!({"text":"ignore"});
            assert!(normalize(provider, &input).unwrap().reply.is_none());
            input["last_assistant_message"] = json!("not a stop");
            input["hook_event_name"] = json!("PreToolUse");
            assert!(normalize(provider, &input).unwrap().reply.is_none());
        }
    }
    #[test]
    fn user_question_relays_the_question_without_reading_provider_files() {
        let input = json!({"hook_event_name":"PreToolUse", "session_id":"12345678-session", "turn_id":"12345678-turn", "tool_name":"AskUserQuestion", "tool_input":{"questions":[{"question":"Which behavior?"}]}});
        let event = normalize(Adapter::Claude, &input).unwrap();
        assert_eq!(event.message.as_deref(), Some("Which behavior?"));
        assert_eq!(event.tool.as_deref(), Some("AskUserQuestion"));
    }
    #[test]
    fn tool_approvals_become_one_allow_or_deny_question_with_a_provider_decision() {
        let mut input = json!({"hook_event_name":"PermissionRequest", "session_id":"12345678-session", "turn_id":"12345678-turn",
            "tool_name":"Bash", "tool_input":{"command":"npm test", "description":"Run tests"}});
        let question = permission_question(&input).unwrap();
        assert_eq!(question.header, "Bash");
        assert_eq!(question.question, "npm test");
        let labels: Vec<_> = question.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, [ALLOW, DENY]);
        input["tool_input"] = json!({"file_path":"src/a.rs", "content":"x".repeat(5000)});
        assert_eq!(permission_question(&input).unwrap().question, "src/a.rs");
        input["tool_input"] = json!({});
        assert_eq!(
            permission_question(&input).unwrap().question,
            "Use this tool"
        );
        // Question tools and plans have their own Chat surfaces.
        for tool in [
            "AskUserQuestion",
            "request_user_input",
            "request_user_input_async",
            "ExitPlanMode",
        ] {
            input["tool_name"] = json!(tool);
            assert!(permission_question(&input).is_none());
        }

        let decision = |answer| permission_output(answer)["hookSpecificOutput"].clone();
        assert_eq!(decision(ALLOW)["hookEventName"], "PermissionRequest");
        assert_eq!(decision(ALLOW)["decision"], json!({"behavior":"allow"}));
        assert_eq!(decision(DENY)["decision"]["behavior"], "deny");
        let noted = decision("use pnpm instead");
        assert_eq!(noted["decision"]["behavior"], "deny");
        assert!(
            noted["decision"]["message"]
                .as_str()
                .unwrap()
                .ends_with("use pnpm instead")
        );
        // Unknown answers never allow, and neither does a reason that reads as approval.
        assert_eq!(decision("allow")["decision"]["behavior"], "deny");
        let reason = decision("Deny: Allow");
        assert_eq!(reason["decision"]["behavior"], "deny");
        assert!(
            reason["decision"]["message"]
                .as_str()
                .unwrap()
                .ends_with(": Allow")
        );
        assert!(
            decision("Deny:")["decision"]["message"]
                .as_str()
                .unwrap()
                .ends_with("Chat.")
        );
    }
    #[test]
    fn codex_automatic_reviewers_keep_their_approvals() {
        let automatic = |config: &str| automatic_reviewer(config, &|_| None);
        assert!(automatic(
            "model = \"x\"\napprovals_reviewer = \"auto_review\"\n"
        ));
        assert!(!automatic("approvals_reviewer = \"user\"\n"));
        assert!(!automatic("model = \"approvals_reviewer\"\n"));
        assert!(!automatic("approvals_reviewer = \"user\" # ask me\n"));
        assert!(!automatic("approvals_reviewer = "));
        // The profile the file selects decides, over the top-level reviewer.
        let profiles = "[profiles.auto]\napprovals_reviewer = \"auto_review\"\n\
            [profiles.me]\napprovals_reviewer = \"user\"\n";
        assert!(automatic(&format!("profile = \"auto\"\n{profiles}")));
        assert!(!automatic(&format!(
            "profile = \"me\"\napprovals_reviewer = \"auto_review\"\n{profiles}"
        )));
        // The command line may select any profile when the file selects none.
        assert!(automatic(profiles));
        assert!(!automatic("[profiles.me]\napprovals_reviewer = \"user\"\n"));
        // A profile's own file comes before its table.
        let file = |name: &str| {
            (name == "me").then(|| "approvals_reviewer = \"auto_review\"\n".to_owned())
        };
        assert!(automatic_reviewer(
            &format!("profile = \"me\"\n{profiles}"),
            &file
        ));
    }
    fn claude_question() -> Value {
        json!({"hook_event_name":"PreToolUse", "session_id":"12345678-session", "turn_id":"12345678-turn",
            "tool_name":"AskUserQuestion", "tool_input":{"questions":[
                {"question":"Pick a color","header":"Color","multiSelect":false,
                    "options":[{"label":"Red","description":"Warm"},{"label":"Blue"}]},
                {"question":"Which sizes?","header":"Size","multiSelect":true,
                    "options":[{"label":"S"},{"label":"M"}]}]}})
    }
    #[test]
    fn question_tools_relay_every_question_and_option_for_both_providers() {
        let event = normalize(Adapter::Claude, &claude_question()).unwrap();
        let questions = event.questions.unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].header, "Color");
        assert_eq!(questions[0].options[0].description, "Warm");
        assert_eq!(questions[1].options.len(), 2);
        assert!(questions[1].multi_select);

        // Codex `request_user_input`, reported as the same question tool.
        let codex = json!({"hook_event_name":"PreToolUse", "session_id":"12345678-session", "turn_id":"12345678-turn",
            "tool_name":"request_user_input", "tool_input":{"questions":[
                {"id":"color","header":"Color","question":"Pick a color",
                    "options":[{"label":"Red","description":"Warm"}]}]}});
        let event = normalize(Adapter::Codex, &codex).unwrap();
        assert_eq!(event.tool.as_deref(), Some("AskUserQuestion"));
        assert_eq!(event.message.as_deref(), Some("Pick a color"));
        assert_eq!(event.questions.unwrap()[0].options[0].label, "Red");

        // Codex's asynchronous tool: `title` for the text, options as plain strings.
        let asynchronous = json!({"hook_event_name":"PreToolUse", "session_id":"12345678-session", "turn_id":"12345678-turn",
            "tool_name":"request_user_input_async", "tool_input":{"questions":[
                {"title":"May I edit directly?","options":["Yes, fix directly","Keep read-only"]},
                {"title":"Which pages fail?"}]}});
        let event = normalize(Adapter::Codex, &asynchronous).unwrap();
        assert_eq!(event.tool.as_deref(), Some("AskUserQuestion"));
        assert_eq!(event.message.as_deref(), Some("May I edit directly?"));
        let questions = event.questions.unwrap();
        assert_eq!(questions[0].question, "May I edit directly?");
        let labels: Vec<_> = questions[0].options.iter().map(|o| &o.label).collect();
        assert_eq!(labels, ["Yes, fix directly", "Keep read-only"]);
        assert!(questions[1].options.is_empty());
        let answers = ["Yes, fix directly".to_string(), "Home pages".to_string()];
        let output = answer_output(Adapter::Codex, &asynchronous, &answers).unwrap();
        let specific = &output["hookSpecificOutput"];
        assert_eq!(specific["permissionDecision"], "deny");
        let reason = specific["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("- May I edit directly?\n  Answer: Yes, fix directly"));
        assert!(reason.contains("- Which pages fail?\n  Answer: Home pages"));

        // Bounded, and only the question tool's own payload.
        let mut long = claude_question();
        long["tool_input"]["questions"] = json!(
            (0..9)
                .map(
                    |i| json!({"question": "q".repeat(900), "header": i.to_string(),
                "options": (0..9).map(|o| json!({"label": o.to_string()})).collect::<Vec<_>>()})
                )
                .collect::<Vec<_>>()
        );
        let questions = normalize(Adapter::Claude, &long)
            .unwrap()
            .questions
            .unwrap();
        assert_eq!(questions.len(), QUESTION_LIMIT);
        assert_eq!(questions[0].options.len(), OPTION_LIMIT);
        assert_eq!(questions[0].question.chars().count(), QUESTION_CHARS);
        let mut other = claude_question();
        other["tool_name"] = json!("Bash");
        assert!(
            normalize(Adapter::Claude, &other)
                .unwrap()
                .questions
                .is_none()
        );
        let mut posted = claude_question();
        posted["hook_event_name"] = json!("PostToolUse");
        assert!(
            normalize(Adapter::Claude, &posted)
                .unwrap()
                .questions
                .is_none()
        );
    }
    #[test]
    fn chat_answers_become_the_providers_own_answers() {
        let input = claude_question();
        let answers = ["Blue".to_string(), "S, M".to_string()];
        let output = answer_output(Adapter::Claude, &input, &answers).unwrap();
        let specific = &output["hookSpecificOutput"];
        assert_eq!(specific["permissionDecision"], "allow");
        assert_eq!(
            specific["updatedInput"]["questions"],
            input["tool_input"]["questions"]
        );
        assert_eq!(
            specific["updatedInput"]["answers"],
            json!({"Pick a color":"Blue","Which sizes?":"S, M"})
        );

        let output = answer_output(Adapter::Codex, &input, &answers).unwrap();
        let specific = &output["hookSpecificOutput"];
        assert_eq!(specific["permissionDecision"], "deny");
        let reason = specific["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("Pick a color\n  Answer: Blue"), "{reason}");

        // Anything incomplete leaves the provider's own menu to ask.
        assert!(answer_output(Adapter::Claude, &input, &answers[..1]).is_none());
        assert!(answer_output(Adapter::Claude, &input, &["Blue".into(), " ".into()]).is_none());
        let mut repeated = input.clone();
        repeated["tool_input"]["questions"][1]["question"] = json!("Pick a color");
        assert!(answer_output(Adapter::Claude, &repeated, &answers).is_none());
    }
    #[test]
    fn question_hooks_wait_long_enough_and_older_installs_need_reinstalling() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        let reporter = stable_reporter().unwrap();
        let installed = json_update(json!({}), Adapter::Claude, &reporter, true).unwrap();
        assert_eq!(
            installed["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"],
            QUESTION_HOOK_TIMEOUT
        );
        assert_eq!(
            installed["hooks"]["Stop"][0]["hooks"][0]["timeout"],
            HOOK_TIMEOUT
        );
        std::fs::write(&source, installed.to_string()).unwrap();
        assert!(inspect(Adapter::Claude, Some(&source)).unwrap().installed);

        let mut older = installed;
        older["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] = json!(3);
        std::fs::write(&source, older.to_string()).unwrap();
        assert!(!inspect(Adapter::Claude, Some(&source)).unwrap().installed);
        // Reinstalling replaces the owned handler rather than adding another.
        let reinstalled = json_update(older, Adapter::Claude, &reporter, true).unwrap();
        let handlers = reinstalled["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0]["hooks"][0]["timeout"], QUESTION_HOOK_TIMEOUT);
    }

    #[test]
    fn secret_paths_are_blocked_and_templates_allowed() {
        for path in [
            ".env",
            ".env.local",
            "config/.env.prod",
            "/repo/.env*",
            "certs/server.pem",
            "tls.key",
            "store.p12",
            "/home/me/.ssh/id_ed25519",
            "id_rsa",
            ".aws/config",
            "credentials.json",
            "secrets.yaml",
            ".npmrc",
            ".netrc",
            "prod.tfvars",
        ] {
            assert!(secret_path(path), "{path}");
        }
        for path in [
            ".env.example",
            "web/.env.sample",
            ".env.template",
            "src/id_utils.ts",
            "src/keys.ts",
            "package.json",
            "",
        ] {
            assert!(!secret_path(path), "{path}");
        }
    }

    #[test]
    fn the_guard_denies_secret_reads_searches_and_commands_only() {
        let call = |tool: &str, input: Value| {
            secret_guard(
                &json!({"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":input}),
            )
        };
        assert!(call("Read", json!({"file_path":"/repo/.env"})).is_some());
        assert!(call("Read", json!({"file_path":"/repo/.env.example"})).is_none());
        assert!(call("Edit", json!({"file_path":"api/.env.local"})).is_some());
        assert!(call("Grep", json!({"pattern":"KEY","glob":".env*"})).is_some());
        assert!(call("Grep", json!({"pattern":"PORT","path":"api"})).is_none());
        assert!(call("Glob", json!({"pattern":"**/.env.*"})).is_some());
        assert!(call("Glob", json!({"pattern":"**/package.json"})).is_none());
        for command in [
            "cat .env",
            "grep PORT api/.env.local",
            "head -5 config/.env.prod | cut -c1-3",
            "ls && cat ~/.ssh/id_rsa",
            "rg --hidden PORT",
            "rg -uu DATABASE_URL",
            "grep -rn SECRET .",
            "source ./.env",
            "grep -rn DATABASE_URL --exclude-dir=node_modules .",
            "grep -r KEY --exclude=*.log .",
            "rg -. PORT",
            "rg -uH PORT",
            "fd -H env",
        ] {
            assert!(
                call("Bash", json!({"command":command})).is_some(),
                "{command}"
            );
        }
        for command in [
            "ls -la .env .env.example",
            "git check-ignore -q .env",
            "test -f .env && echo present",
            "cat .env.example",
            "rg PORT src",
            "grep -rn PORT --exclude=.env* .",
            "grep -rn PORT --exclude .env* .",
            "rg -H PORT src",
            "npm test",
        ] {
            assert!(
                call("Bash", json!({"command":command})).is_none(),
                "{command}"
            );
        }
        assert!(call("exec", json!({"command":["cat", ".env"]})).is_some());
        assert_eq!(
            deny_output("x")["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
    }
}
