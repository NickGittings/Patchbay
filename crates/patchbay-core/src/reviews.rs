//! Whole-branch review jobs and per-branch findings, stored outside the source tree.
use crate::context;
use crate::git;
use crate::merges::{AgentJob, owned_dirs};
use crate::model::{Project, REVIEW_SCOPE, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Instant, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Severities {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub clean: bool,
    pub counts: Severities,
}

/// Read an explicit verdict, allowing Markdown headings and emphasis around its label.
/// Count the leading severity of each finding; prose, legends and quoted tags don't count.
/// An optional `Counts:` line right after the verdict (blank lines aside) reports totals: each
/// severity takes the larger of the reported and the counted total, since neither alone may hide a
/// finding, and a clean verdict with any finding reads as issues. Unreadable totals there give no
/// verdict; a `Counts:` line anywhere else is prose.
#[must_use]
pub fn verdict(text: &str) -> Option<Verdict> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines().peekable();
    let clean = lines.find_map(|line| {
        let header = line
            .trim()
            .trim_start_matches('#')
            .trim()
            .replace(['*', '`', '_'], "")
            .to_ascii_lowercase();
        let (key, value) = header.split_once(':')?;
        if key.trim() != "verdict" {
            return None;
        }
        // Only the first word counts, so "clean." or "issues (2)" still read.
        match value
            .trim()
            .split(|c: char| !c.is_ascii_alphabetic())
            .next()?
        {
            "clean" => Some(true),
            "issues" => Some(false),
            _ => None,
        }
    })?;
    while lines.next_if(|line| line.trim().is_empty()).is_some() {}
    let reported = match lines.peek().and_then(|line| counts_value(line)) {
        Some(value) => {
            lines.next();
            Some(serde_json::from_str::<Severities>(&value).ok()?)
        }
        None => None,
    };
    let mut counts = Severities::default();
    let mut legend_section = false;
    let mut code_block = false;
    for line in lines {
        let line = line.trim().to_ascii_lowercase();
        if line.starts_with("```") || line.starts_with("~~~") {
            code_block = !code_block;
            continue;
        }
        if code_block {
            continue;
        }
        if line.starts_with('#') {
            let heading = line
                .trim_start_matches('#')
                .trim()
                .trim_matches(['*', '`', '_', ':']);
            // A tagged heading is a finding, even one about a chart's legend.
            legend_section = !heading.starts_with('[')
                && (heading == "legend"
                    || heading.ends_with(" legend")
                    || matches!(
                        heading,
                        "severities" | "severity levels" | "severity definitions"
                    ));
        }
        if legend_section {
            continue;
        }
        // Ignore Markdown emphasis around either a tag or a list number.
        let finding = line.replace(['*', '`', '_'], "");
        // A severity column needn't be the first column of a Markdown table.
        let table_finding = finding.strip_prefix('|').and_then(|row| {
            let cells: Vec<_> = row.split('|').map(str::trim).collect();
            let tag = cells.iter().find_map(|cell| {
                let tag = cell.strip_prefix('[')?.strip_suffix(']')?.trim();
                matches!(tag, "critical" | "high" | "medium" | "low").then_some(tag)
            })?;
            // Counts, row numbers and bare severity tags aren't descriptions. A finding
            // table must also have a cell containing the actual issue's text.
            let description = cells.into_iter().find(|cell| {
                !matches!(*cell, "[critical]" | "[high]" | "[medium]" | "[low]")
                    && cell.chars().any(char::is_alphabetic)
            })?;
            Some((tag, description))
        });
        if finding.starts_with('|') && table_finding.is_none() {
            continue;
        }
        let line = finding
            .trim_start_matches(['#', '-', '+', '|'])
            .trim_start();
        let line = if let Some((number, rest)) = line.split_once(['.', ')']) {
            if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
                rest.trim_start()
            } else {
                line
            }
        } else {
            line
        };
        // A checked or unchecked task list item can still contain a finding.
        let line = ["[ ]", "[x]"]
            .into_iter()
            .find_map(|box_tag| line.strip_prefix(box_tag))
            .unwrap_or(line)
            .trim_start();
        let Some((tag, description)) =
            table_finding.or_else(|| line.strip_prefix('[').and_then(|s| s.split_once(']')))
        else {
            continue;
        };
        let tag = tag.trim();
        let description = description.trim().trim_matches('|').trim();
        // A list of bare tags describes the severity scheme, not a finding.
        if description.is_empty()
            || description
                .split(|c: char| c.is_whitespace() || matches!(c, ',' | '|' | '/'))
                .all(|word| {
                    matches!(
                        word.trim_matches(['*', '`', '_']),
                        "" | "and" | "or" | "[critical]" | "[high]" | "[medium]" | "[low]"
                    )
                })
        {
            continue;
        }
        let count = match tag {
            "critical" => &mut counts.critical,
            "high" => &mut counts.high,
            "medium" => &mut counts.medium,
            "low" => &mut counts.low,
            _ => continue,
        };
        *count += 1;
    }
    if let Some(reported) = reported {
        counts.critical = counts.critical.max(reported.critical);
        counts.high = counts.high.max(reported.high);
        counts.medium = counts.medium.max(reported.medium);
        counts.low = counts.low.max(reported.low);
    }
    Some(Verdict {
        clean: clean && counts == Severities::default(),
        counts,
    })
}

/// The value of a `Counts:` line, allowing a heading mark and Markdown emphasis around it.
fn counts_value(line: &str) -> Option<String> {
    let line = line
        .trim()
        .trim_start_matches('#')
        .trim()
        .replace(['*', '`', '_'], "")
        .to_ascii_lowercase();
    let rest = line
        .strip_prefix("counts")?
        .trim_start()
        .strip_prefix(':')?;
    Some(rest.trim().to_owned())
}

/// Adapt Codex's final Markdown report and parse its verdict once.
/// Native reviews may end with an explicit no-findings conclusion instead of Patchbay headers.
#[must_use]
pub fn from_codex(text: &str) -> (String, Option<Verdict>) {
    codex_report(text, false)
}

fn codex_report(text: &str, truncated: bool) -> (String, Option<Verdict>) {
    let text = codex_tags(text);
    // Counts in the prefix still cover findings beyond the display limit.
    let incomplete = codex_incomplete(&text);
    if let Some(parsed) = verdict(&text) {
        let parsed = (!parsed.clean || !incomplete).then_some(parsed);
        return (text, parsed);
    }
    let parsed = verdict(&format!("Verdict: issues\n\n# Codex review\n{text}"))
        .filter(|v| v.counts != Severities::default())
        .or_else(|| {
            // Never infer clean from a cut conclusion, arbitrary prose or a
            // malformed explicit contract. Native final messages commonly omit
            // the headers even when requested in developer instructions.
            (!truncated && !incomplete && codex_clean(&text)).then(|| Verdict {
                clean: true,
                counts: Severities::default(),
            })
        });
    let Some(parsed) = parsed else {
        return (text, None);
    };
    let label = if parsed.clean { "clean" } else { "issues" };
    let text = format!(
        "Verdict: {label}\nCounts: {}\n\n{text}",
        serde_json::to_string(&parsed.counts).unwrap()
    );
    (text, Some(parsed))
}

/// Codex's `[P0]`–`[P3]` tags as Patchbay's severities, leaving code blocks and
/// inline code (`weights[P1]`) as written.
fn codex_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fenced = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let fence = trimmed.starts_with("```") || trimmed.starts_with("~~~");
        fenced ^= fence;
        if fence || fenced {
            out.push_str(line);
            continue;
        }
        for (i, part) in line.split('`').enumerate() {
            if i > 0 {
                out.push('`');
            }
            if i % 2 == 1 {
                out.push_str(part);
            } else {
                out.push_str(
                    &part
                        .replace("[P0]", "[critical]")
                        .replace("[P1]", "[high]")
                        .replace("[P2]", "[medium]")
                        .replace("[P3]", "[low]"),
                );
            }
        }
    }
    out
}

/// A report's prose, lowercased line by line: code blocks and inline code are left
/// out, so quoted code such as `error:` never reads as the reviewer's own words.
fn prose_lines(text: &str) -> Vec<String> {
    let mut fenced = false;
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                fenced = !fenced;
                return None;
            }
            (!fenced).then(|| {
                line.split('`')
                    .step_by(2)
                    .collect::<String>()
                    .to_ascii_lowercase()
            })
        })
        .collect()
}

/// A prose line without its list, quote, heading or emphasis marks.
fn bare(line: &str) -> &str {
    line.trim()
        .trim_start_matches(['#', '*', '-', '+', '>', '_'])
        .trim()
}

fn codex_incomplete(text: &str) -> bool {
    prose_lines(text).iter().any(|line| {
        [
            "unable to complete",
            "unable to review",
            "could not complete",
            "could not review",
            "could not access",
            "couldn't complete",
            "couldn't review",
            "review incomplete",
            "review interrupted",
            "review failed",
            "review did not complete",
            "didn't complete the review",
        ]
        .iter()
        .any(|phrase| line.contains(phrase))
            // Status words only count where a line starts with them.
            || ["error:", "no findings yet"]
                .iter()
                .any(|phrase| bare(line).starts_with(phrase))
    })
}

/// An explicit, unqualified no-findings conclusion. Any hedge anywhere in the prose
/// ("…, but the retry loop never ends") leaves the report without a verdict, which
/// Auto treats as unreadable rather than clean.
fn codex_clean(text: &str) -> bool {
    let lines = prose_lines(text);
    if lines
        .iter()
        .any(|line| line.contains("verdict:") || counts_value(line).is_some())
    {
        return false;
    }
    let hedged = lines.iter().any(|line| {
        let words: Vec<&str> = line
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '\'')
            .filter(|w| !w.is_empty())
            .collect();
        words.iter().any(|w| {
            matches!(
                *w,
                "but" | "however" | "except" | "although" | "though" | "unless" | "yet"
            )
        }) || ["apart from", "aside from", "other than", "that said"]
            .iter()
            .any(|phrase| line.contains(phrase))
    });
    if hedged {
        return false;
    }
    lines.iter().any(|line| {
        let line = bare(line);
        // "The patch is correct" must end its sentence: "… in most respects" qualifies it.
        line.strip_prefix("the patch is correct")
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['.', '!']))
            || [
                "no findings",
                "no actionable findings",
                "no actionable issues",
                "no issues found",
                "no bugs found",
            ]
            .iter()
            .any(|phrase| {
                line.strip_prefix(phrase).is_some_and(|rest| {
                    rest.is_empty() || rest.starts_with(['.', ',', ':', ';', '!', ' '])
                })
            })
            || [
                "i did not find any ",
                "i didn't find any ",
                "i found no ",
                "i did not identify any ",
                "i didn't identify any ",
            ]
            .iter()
            .any(|prefix| {
                line.strip_prefix(prefix).is_some_and(|rest| {
                    rest.split('.').next().is_some_and(|sentence| {
                        ["findings", "issues", "bugs", "regressions"]
                            .iter()
                            .any(|noun| {
                                sentence
                                    .split_whitespace()
                                    .any(|word| word.trim_matches([',', ';', ':']) == *noun)
                            })
                    })
                })
            })
    })
}

pub const REVIEW_FILE_ENV: &str = "PATCHBAY_REVIEW_FILE";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub worktree: String,
    pub branch: String,
    pub base: String,
    /// The reviewer (its preset id) when several review the branch at once, each in its
    /// own session and findings file; `None` for a single reviewer.
    #[serde(default)]
    pub lane: Option<String>,
    /// Shared by reviewers launched together, so findings combine only within one round.
    #[serde(default)]
    pub round: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FindingsStamp {
    modified: SystemTime,
    len: u64,
}

impl FindingsStamp {
    fn read(path: &Path) -> Option<Self> {
        Self::of(&std::fs::metadata(path).ok()?)
    }

    fn of(metadata: &std::fs::Metadata) -> Option<Self> {
        Some(Self {
            modified: metadata.modified().ok()?,
            len: metadata.len(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native: Option<context::ReviewStyle>,
    /// Native Codex base review omits files that were untracked at launch.
    #[serde(default)]
    excluded_untracked: bool,
    /// The base commit a native Codex command names; its resume reruns against it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_commit: Option<String>,
    branch: String,
    head: String,
    base: String,
    merge_base: String,
    started_ms: u64,
    /// Unique per attempt, so a rollback recognises the sidecar it wrote.
    #[serde(default)]
    attempt: String,
    /// The launch this attempt belongs to; reviewers started together share it.
    #[serde(default)]
    round: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lane: Option<String>,
    /// Existing findings stay available for handoff, but cannot finish this attempt.
    #[serde(default)]
    previous_findings: Option<FindingsStamp>,
    /// The round (`round_key`) and base of the attempt this one replaced in the same
    /// lane, whose findings the file holds until this attempt writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<Previous>,
    /// An uncertain launch is visible until this reviewer actually writes findings.
    #[serde(default)]
    launch_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Previous {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native: Option<context::ReviewStyle>,
    round: String,
    base: String,
}

/// What groups a round's attempts: their shared round id, else (for sidecars from
/// before rounds) the attempt alone.
fn round_key(started: &Started) -> String {
    if started.round.is_empty() {
        format!("attempt:{}", started.attempt)
    } else {
        format!("round:{}", started.round)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Findings {
    pub verdict: Option<Verdict>,
    pub text: String,
    pub modified_ms: u64,
    /// Absent when the findings predate the latest review attempt.
    pub reviewed_head: Option<String>,
    /// The base branch of the findings `text` shows.
    pub base: String,
    /// The latest review round: reviewers launched together share it. `reviewers`,
    /// `verdict` and `reviewed_head` describe this round, while `text` may still show an
    /// earlier round's findings until one of its reviewers writes. Empty for reviews
    /// recorded before rounds.
    pub round: String,
    /// When the review attempt started; later changes weren't reviewed.
    pub started_ms: u64,
    /// Worktree edits are newer than the review, or coverage could not be checked.
    pub edited_since_start: bool,
    /// A native Codex reviewer left out untracked files that were present at launch
    /// or are present now. The findings stay current, but can't merge automatically.
    pub uncovered: bool,
    pub truncated: bool,
    /// Each reviewer of the round, by lane; one entry for a single reviewer.
    pub reviewers: Vec<Reviewer>,
}

/// One reviewer's part of a round's findings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub lane: Option<String>,
    /// It wrote findings since its attempt started.
    pub finished: bool,
    pub verdict: Option<Verdict>,
    pub error: Option<String>,
}

/// The verdict of several reviewers: issues if any reports issues, and per severity
/// the largest count, since reviewers often report the same finding. `None` while
/// any reviewer has no readable verdict.
#[must_use]
pub fn combined(verdicts: impl IntoIterator<Item = Option<Verdict>>) -> Option<Verdict> {
    verdicts.into_iter().try_fold(
        Verdict {
            clean: true,
            counts: Severities::default(),
        },
        |all, one| {
            let one = one?;
            Some(Verdict {
                clean: all.clean && one.clean,
                counts: Severities {
                    critical: all.counts.critical.max(one.counts.critical),
                    high: all.counts.high.max(one.counts.high),
                    medium: all.counts.medium.max(one.counts.medium),
                    low: all.counts.low.max(one.counts.low),
                },
            })
        },
    )
}

/// Serializes sidecar writes, so a rollback can't overwrite a newer attempt's.
static SIDECARS: Mutex<()> = Mutex::new(());

/// A recorded review attempt: findings written after it count for its HEAD.
pub struct Attempt {
    sidecar: PathBuf,
    previous: Option<Vec<u8>>,
    written: Vec<u8>,
    briefing: Option<PathBuf>,
    cache_key: PathBuf,
}

impl Attempt {
    fn record(sidecar: PathBuf, started: &Started, briefing: Option<PathBuf>) -> Result<Self> {
        let _guard = SIDECARS.lock().unwrap_or_else(PoisonError::into_inner);
        let mut started = started.clone();
        started.previous_findings = FindingsStamp::read(&sidecar.with_extension("md"));
        let previous = std::fs::read(&sidecar).ok();
        started.previous = previous
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<Started>(bytes).ok())
            .and_then(|old| {
                if started.previous_findings == old.previous_findings {
                    // This attempt never replaced the file. Keep the provenance
                    // of the report it inherited, including legacy Patchbay output.
                    old.previous
                } else {
                    Some(Previous {
                        native: old.native,
                        round: round_key(&old),
                        base: old.base,
                    })
                }
            });
        let written = serde_json::to_vec(&started)?;
        // Atomic replacement keeps readers from pairing new findings with a partial sidecar.
        crate::plans::write_atomic(&sidecar, &written)?;
        let cache_key = sidecar.parent().unwrap().join(name(&started.branch));
        ROUNDS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&cache_key);
        Ok(Self {
            sidecar,
            previous,
            written,
            briefing,
            cache_key,
        })
    }

    /// Put back the sidecar this attempt replaced, best-effort, unless a later attempt
    /// has replaced it since.
    pub fn rollback(self) {
        {
            let _guard = SIDECARS.lock().unwrap_or_else(PoisonError::into_inner);
            if std::fs::read(&self.sidecar).ok().as_deref() == Some(self.written.as_slice()) {
                let _ = match &self.previous {
                    Some(bytes) => crate::plans::write_atomic(&self.sidecar, bytes),
                    None => std::fs::remove_file(&self.sidecar).map_err(Into::into),
                };
                ROUNDS
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&self.cache_key);
            }
        }
        if let Some(file) = &self.briefing {
            context::remove_owned_briefing_file(file);
        }
    }

    /// Run `start`, rolling back unless it may have started the session: its error
    /// says whether the session may be running anyway (a lost reply), in which case
    /// that session owns this attempt.
    ///
    /// # Errors
    /// Returns `start`'s error.
    pub fn launch<T>(self, start: impl FnOnce() -> Result<T, (String, bool)>) -> Result<T, String> {
        match start() {
            Ok(value) => Ok(value),
            Err((error, true)) => {
                let _guard = SIDECARS.lock().unwrap_or_else(PoisonError::into_inner);
                // Best-effort: an unreadable record only loses the launch error's display.
                if std::fs::read(&self.sidecar).ok().as_deref() == Some(self.written.as_slice())
                    && let Ok(mut started) = serde_json::from_slice::<Started>(&self.written)
                {
                    started.launch_error = Some(error.clone());
                    if let Ok(bytes) = serde_json::to_vec(&started) {
                        let _ = crate::plans::write_atomic(&self.sidecar, &bytes);
                    }
                    ROUNDS
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&self.cache_key);
                }
                Err(error)
            }
            Err((error, false)) => {
                // A refused launch must not invalidate or re-attribute saved findings.
                self.rollback();
                Err(error)
            }
        }
    }
}

/// A prepared review whose sidecar is already recorded, so findings written as soon
/// as the agent starts are attributed to it.
pub struct Prepared {
    pub job: AgentJob,
    attempt: Attempt,
}

impl Prepared {
    /// Undo the recorded attempt and remove the briefing, best-effort.
    pub fn rollback(self) {
        self.attempt.rollback();
    }

    /// Start the job with `start`, rolling back as [`Attempt::launch`] does.
    ///
    /// # Errors
    /// Returns `start`'s error.
    pub fn launch<T>(
        self,
        start: impl FnOnce(AgentJob) -> Result<T, (String, bool)>,
    ) -> Result<T, String> {
        let Self { job, attempt } = self;
        attempt.launch(|| start(job))
    }
}

// Include branch identity because slug alone aliases feature/a, feature-a and Feature-a.
fn name(branch: &str) -> String {
    let identity = crate::workspace::session_id(branch, REVIEW_SCOPE, "findings");
    format!("{}-{}", crate::detect::slug(branch), &identity[2..18])
}

/// Create the canonical reviews folder.
///
/// # Errors
/// Fails for a non-repository root or filesystem errors.
pub fn dir(root: &Path) -> Result<PathBuf> {
    let dir = crate::tasks::store_dir(root)?.join("reviews");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.canonicalize()?)
}

/// Existing reviews folder, without creating it.
#[must_use]
pub fn existing_dir(root: &Path) -> Option<PathBuf> {
    crate::tasks::store_dir(root)
        .ok()?
        .join("reviews")
        .canonicalize()
        .ok()
}

/// Findings path, with a safe filename for any branch, inside the canonical folder
/// once it exists, so it matches the folder agents are granted.
///
/// # Errors
/// Fails when the root isn't in a repository.
pub fn file(root: &Path, branch: &str) -> Result<PathBuf> {
    lane_file(root, branch, None)
}

/// A reviewer's findings path: the branch's own for a single reviewer, else beside it
/// with the lane's identity, which needs no validation to stay inside the folder.
fn in_lane(folder: &Path, branch: &str, lane: Option<&str>) -> PathBuf {
    named_lane(folder, &name(branch), lane)
}

fn named_lane(folder: &Path, name: &str, lane: Option<&str>) -> PathBuf {
    match lane {
        None => folder.join(format!("{name}.md")),
        Some(lane) => {
            let identity = crate::workspace::session_id(lane, REVIEW_SCOPE, "lane");
            folder.join(format!(
                "{}~{}-{}.md",
                name,
                crate::detect::slug(lane),
                &identity[2..10]
            ))
        }
    }
}

/// [`file`] for reviewer `lane`.
///
/// # Errors
/// Fails when the root isn't in a repository.
pub fn lane_file(root: &Path, branch: &str, lane: Option<&str>) -> Result<PathBuf> {
    let folder = match existing_dir(root) {
        Some(folder) => folder,
        None => crate::tasks::store_dir(root)?.join("reviews"),
    };
    Ok(in_lane(&folder, branch, lane))
}

/// Whether `path` belongs to the precomputed branch prefix (any lane).
fn of_branch(path: &Path, prefix: &str) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem == prefix
                || stem
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('~'))
        })
}

/// Prepare a review without modifying repository files or Git state.
/// Native Codex uses a read-only sandbox; other agents receive read-only instructions.
/// Launch it with `Prepared::launch`, which rolls back a refused launch.
///
/// # Errors
/// Fails for missing, foreign, detached or changed worktrees, invalid refs, a base equal
/// to the reviewed branch, policy or I/O.
pub fn prepare(
    project: &Project,
    request: &ReviewRequest,
    terminal: &TerminalSpec,
    policy: &dyn Policy,
    auto: Option<&context::AutoBrief>,
) -> Result<Prepared> {
    let root = Path::new(&project.root);
    ensure!(
        git::worktrees(root)
            .iter()
            .any(|t| t.path == request.worktree),
        "The review worktree is missing or isn't in this project's repository"
    );
    let cwd = Path::new(&request.worktree);
    let common = git::common_dir(root)?.canonicalize()?;
    owned_dirs(cwd, &common)?;
    let branch = current_branch(cwd)
        .context("The review worktree has a detached HEAD; check out a branch first")?;
    ensure!(
        branch == request.branch,
        "The review branch changed; refresh Review and try again"
    );
    ensure!(
        request.base != request.branch,
        "Choose a base other than the reviewed branch"
    );
    crate::tasks::check_branch(cwd, &request.base)?;
    // Native commands use a verified object id, never a branch name in a bare
    // kickoff argument (npm's Windows shims expand these inside cmd blocks).
    let base_commit = git::run(git::git(cwd).args([
        "rev-parse",
        "--verify",
        &format!("{}^{{commit}}", request.base),
    ]))
    .with_context(|| format!("Unknown review base: {}", request.base))?;
    let head = git::run(git::git(cwd).args(["rev-parse", "HEAD"]))?;
    let merge_base = git::run(git::git(cwd).args(["merge-base", &base_commit, "HEAD"]))?;
    let folder = dir(root)?;
    let lane = request.lane.as_deref().filter(|l| !l.is_empty());
    let findings = in_lane(&folder, &request.branch, lane);
    let mut terminal = terminal.clone();
    // One session slot per worktree and reviewer.
    let slot = lane.map_or_else(|| "review".into(), |lane| format!("review~{lane}"));
    terminal.id = crate::workspace::session_id(&request.worktree, REVIEW_SCOPE, &slot);
    terminal.name = match lane {
        Some(_) => format!("Review · {} · {}", request.branch, terminal.name),
        None => format!("Review · {}", request.branch),
    };
    let style = context::review_style(&terminal.command);
    let scope = if style == context::ReviewStyle::Claude {
        format!(
            "Whole-branch scope: git diff {merge_base}..HEAD, uncommitted changes with git diff HEAD including staged changes, and untracked files. Component filters do not limit this job."
        )
    } else if style == context::ReviewStyle::Codex {
        format!(
            "Review the entire branch against base commit {base_commit}, including tracked uncommitted changes. Native base-branch review excludes untracked files; they are outside this review's coverage. Component filters do not limit this job. Read the repository's contribution instructions."
        )
    } else {
        format!(
            "Review the entire branch's committed work with git diff {merge_base}..HEAD, its uncommitted changes with git diff HEAD (including staged changes), and untracked files. Review's component filters do not limit this job. Read the repository's contribution instructions."
        )
    };
    let read_only = if style == context::ReviewStyle::Claude {
        "Do not edit source files, stage, commit, stash, reset or check out anything. Do not change Git state or run checks that modify the tree."
    } else if style == context::ReviewStyle::Codex {
        "Report findings only. Do not edit source files, stage, commit, stash, reset or check out anything. Do not change Git state or run checks that modify the tree. Patchbay enforces a read-only sandbox without approval escalation; the CLI saves the final findings. Native base-branch review excludes untracked files, so they are not covered by this review."
    } else {
        "Report findings only. Do not edit source files, stage, commit, stash, reset or check out anything. Do not change Git state or run checks that modify the tree. Fixes belong in Implementation. Read-only behavior relies on these instructions; Patchbay does not rewrite the user's agent command to enforce it."
    };
    let report = if style == context::ReviewStyle::Claude {
        format!(
            "After /code-review reports, write its findings with file:line references to $PATCHBAY_REVIEW_FILE ({}), replacing previous findings, in this format.",
            findings.display()
        )
    } else if style == context::ReviewStyle::Codex {
        "Return findings ranked by severity with file:line references in your final message. The CLI saves it to PATCHBAY_REVIEW_FILE; do not write the file yourself. Explain the impact and evidence for each finding.".into()
    } else {
        format!(
            "Write findings ranked by severity with file:line references to $PATCHBAY_REVIEW_FILE ({}), replacing previous findings. Explain the impact and evidence for each finding.",
            findings.display()
        )
    };
    let file_rule = if style == context::ReviewStyle::Codex {
        "Do not write any files; the CLI saves your final report."
    } else {
        "This findings file is the only file you may write."
    };
    let mut text = format!(
        "# Patchbay branch review\n\nProject: {}\nWorktree: {}\nBranch: {}\nHEAD: {head}\nBase branch: {}\nMerge base: {merge_base}\n\n\
         {scope}\n\n\
         {read_only}\n\n\
         {report} Start the report with exactly Verdict: clean or Verdict: issues. The second line must be Counts: {{\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}}, with nonnegative integer totals for ALL open findings at each severity. Include all four keys exactly once, no other keys, and no Markdown around these two lines. Use clean only when all counts are zero; use issues otherwise. These counts control automatic merging, so verify them against every finding before finishing. Tag each finding [critical], [high], [medium] or [low]. If there are no findings, say so explicitly. {file_rule}\n",
        project.name, request.worktree, request.branch, request.base,
    );
    if let Some(auto) = auto {
        text.push_str(&auto.markdown("review"));
    }
    let mut scoped = project.clone();
    scoped.root.clone_from(&request.worktree);
    scoped.components.clear();
    scoped.links.clear();
    scoped.groups.clear();
    let spec = context::native_review_spec(
        &scoped,
        &terminal,
        &text,
        vec![folder],
        style,
        &base_commit,
        &findings,
        policy,
    )?;
    let started = Started {
        native: match style {
            context::ReviewStyle::Claude => Some(context::ReviewStyle::Claude),
            context::ReviewStyle::Codex => Some(context::ReviewStyle::Codex),
            context::ReviewStyle::Patchbay => None,
        },
        excluded_untracked: style == context::ReviewStyle::Codex
            && git::has_untracked(cwd).unwrap_or(true),
        base_commit: (style == context::ReviewStyle::Codex).then(|| base_commit.clone()),
        branch: request.branch.clone(),
        head,
        base: request.base.clone(),
        merge_base,
        started_ms: crate::status::unix_ms(SystemTime::now()),
        attempt: uuid::Uuid::new_v4().to_string(),
        round: request
            .round
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        lane: lane.map(Into::into),
        previous_findings: None,
        previous: None,
        launch_error: None,
    };
    let briefing = context::owned_briefing(&spec);
    match Attempt::record(findings.with_extension("json"), &started, briefing.clone()) {
        Ok(attempt) => Ok(Prepared {
            job: AgentJob { terminal, spec },
            attempt,
        }),
        Err(error) => {
            if let Some(file) = briefing {
                context::remove_owned_briefing_file(&file);
            }
            Err(error)
        }
    }
}

/// Record a new attempt for a review session about to resume, so findings it writes
/// count for its worktree's current HEAD. `None` when the HEAD and worktree are
/// unchanged since the last attempt, so
/// resuming alone doesn't age current findings.
///
/// # Errors
/// Fails when the branch's review record is missing, its identity doesn't match,
/// or the worktree no longer has the reviewed branch checked out.
pub fn resume_attempt(
    root: &Path,
    spec: &SessionSpec,
    branch: &str,
    lane: Option<&str>,
) -> Result<Option<Attempt>> {
    // Session summaries deliberately strip the launch environment. Use the recorded
    // branch and lane to find the artifact, rather than depending on PATCHBAY_REVIEW_FILE.
    let findings = lane_file(root, branch, lane)?;
    let folder = existing_dir(root).context("The reviews folder is missing")?;
    let sidecar = findings.with_extension("json");
    let old: Started = serde_json::from_slice(
        &std::fs::read(&sidecar).context("The review's record is missing; start a new review")?,
    )?;
    ensure!(
        in_lane(&folder, &old.branch, old.lane.as_deref()) == findings,
        "The review's findings file is outside the reviews folder"
    );
    let cwd = spec.cwd.as_path();
    let branch = current_branch(cwd).unwrap_or_default();
    ensure!(
        branch == old.branch,
        "The review worktree no longer has {} checked out; start a new review",
        old.branch
    );
    let head = git::run(git::git(cwd).args(["rev-parse", "HEAD"]))?;
    if head == old.head && !git::changed_since(cwd, old.started_ms).unwrap_or(true) {
        return Ok(None);
    }
    // A Codex resume reruns its recorded command, which names the launch's base commit,
    // so its range is measured from that commit rather than the base branch's tip.
    let base = old.base_commit.as_deref().unwrap_or(&old.base);
    let merge_base = git::run(git::git(cwd).args(["merge-base", base, "HEAD"]))
        .with_context(|| format!("The review base {} is gone; start a new review", old.base))?;
    let started = Started {
        excluded_untracked: old.native == Some(context::ReviewStyle::Codex)
            && git::has_untracked(cwd).unwrap_or(true),
        head,
        merge_base,
        started_ms: crate::status::unix_ms(SystemTime::now()),
        attempt: uuid::Uuid::new_v4().to_string(),
        // A resumed reviewer covers the new tree on its own. Pulling its old peers
        // forward would mix commits and could revive findings from an older round.
        round: uuid::Uuid::new_v4().to_string(),
        previous_findings: None,
        previous: None,
        launch_error: None,
        ..old
    };
    Attempt::record(sidecar, &started, None).map(Some)
}

/// Read capped findings. Older findings remain visible, but have no reviewed HEAD.
#[must_use]
pub fn read(root: &Path, branch: &str) -> Option<Findings> {
    load(root, branch, crate::plans::PLAN_LIMIT)
}

/// One reviewer's saved findings, read up to a limit.
struct Saved {
    file: PathBuf,
    text: String,
    truncated: bool,
    modified_ms: u64,
    started: Started,
    stamp: Option<FindingsStamp>,
    verdict: Option<Verdict>,
    /// An earlier round's findings, shown while the latest round has none of its own.
    superseded: bool,
}

impl Saved {
    /// Reviewer `file` of attempt `started`, stamped but not read yet. A missing or
    /// unreadable file has no stamp.
    fn stamped(file: PathBuf, started: Started, superseded: bool) -> Self {
        let stamp = FindingsStamp::read(&file);
        Self {
            modified_ms: stamp
                .as_ref()
                .map_or(0, |s| crate::status::unix_ms(s.modified)),
            file,
            text: String::new(),
            verdict: None,
            truncated: false,
            started,
            stamp,
            superseded,
        }
    }

    /// Open and stamp the same file that will be read, before assigning its budget.
    fn open(&mut self) -> Option<std::fs::File> {
        let opened = (|| {
            let handle = std::fs::File::open(&self.file).ok()?;
            let metadata = handle.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((handle, FindingsStamp::of(&metadata)?))
        })();
        self.stamp = opened.as_ref().map(|(_, stamp)| stamp.clone());
        self.modified_ms = self
            .stamp
            .as_ref()
            .map_or(0, |s| crate::status::unix_ms(s.modified));
        opened.map(|(handle, _)| handle)
    }

    /// Read the already-open file up to its assigned share.
    fn read(mut self, handle: Option<std::fs::File>, limit: usize) -> Self {
        let found = (|| {
            let handle = handle?;
            let stamp = self.stamp.clone()?;
            let native = if Some(&stamp) == self.started.previous_findings.as_ref() {
                // No previous sidecar means legacy Patchbay findings, not output
                // from the current (possibly Codex) attempt.
                self.started.previous.as_ref().and_then(|p| p.native)
            } else {
                self.started.native
            };
            let cached = REPORTS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_mut(&self.file)
                .filter(|c| {
                    c.stamp == stamp
                        && c.native == native
                        && (c.limit == limit
                            || (!c.report.truncated
                                && stamp.len <= u64::try_from(limit).unwrap_or(u64::MAX)))
                })
                .map(|c| {
                    c.used = Instant::now();
                    c.report.clone()
                });
            let report = match cached {
                Some(report) => report,
                None => {
                    let (text, truncated) = crate::plans::read_limited(handle, limit).ok()?;
                    let (text, verdict) = if native == Some(context::ReviewStyle::Codex) {
                        codex_report(&text, truncated)
                    } else {
                        let parsed = verdict(&text);
                        (text, parsed)
                    };
                    let report = Report {
                        text,
                        truncated,
                        verdict,
                    };
                    cache_report(
                        self.file.clone(),
                        stamp.clone(),
                        native,
                        limit,
                        report.clone(),
                    );
                    report
                }
            };
            Some((report, stamp))
        })();
        if let Some((report, stamp)) = found {
            self.modified_ms = crate::status::unix_ms(stamp.modified);
            self.text = report.text;
            self.verdict = report.verdict;
            self.truncated = report.truncated;
            self.stamp = Some(stamp);
        } else {
            self.modified_ms = 0;
            self.text.clear();
            self.verdict = None;
            self.truncated = false;
            self.stamp = None;
        }
        self
    }

    /// Written since its attempt started, so it covers that attempt's HEAD. Never
    /// true for an earlier round's findings: a newer review hasn't written yet.
    fn fresh(&self) -> bool {
        !self.superseded
            && self.modified_ms > self.started.started_ms
            && self.stamp != self.started.previous_findings
    }

    fn lane(&self) -> &str {
        self.started.lane.as_deref().unwrap_or("reviewer")
    }
}

#[derive(Clone)]
struct Report {
    text: String,
    truncated: bool,
    verdict: Option<Verdict>,
}

struct CachedReport {
    stamp: FindingsStamp,
    native: Option<context::ReviewStyle>,
    limit: usize,
    report: Report,
    used: Instant,
}

// Poll unchanged reports without rereading, converting and reparsing their Markdown.
static REPORTS: Mutex<BTreeMap<PathBuf, CachedReport>> = Mutex::new(BTreeMap::new());

fn cache_report(
    file: PathBuf,
    stamp: FindingsStamp,
    native: Option<context::ReviewStyle>,
    limit: usize,
    report: Report,
) {
    let mut cache = REPORTS.lock().unwrap_or_else(PoisonError::into_inner);
    if cache.len() >= ROUND_CACHE_LIMIT
        && !cache.contains_key(&file)
        && let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, c)| c.used)
            .map(|(p, _)| p.clone())
    {
        cache.remove(&oldest);
    }
    cache.insert(
        file,
        CachedReport {
            stamp,
            native,
            limit,
            report,
            used: Instant::now(),
        },
    );
}

/// A branch's reviewers: the latest round, and the findings shown for it.
#[derive(Default)]
struct Lanes {
    /// Every reviewer of the latest round (the round of the most recently started
    /// attempt), by lane. A reviewer whose file is missing or unreadable counts as
    /// one that hasn't written yet.
    round: Vec<Saved>,
    /// While no reviewer of the latest round has written, the most recently written
    /// earlier findings, whichever reviewers wrote them; `None` shows the round's own.
    earlier: Option<Vec<Saved>>,
}

impl Lanes {
    /// The findings to show and hand off: never empty unless there are none at all.
    fn shown(&self) -> &[Saved] {
        self.earlier.as_deref().unwrap_or(&self.round)
    }
}

/// Split `limit` bytes between reports of stamped sizes `lens`, smallest first: a
/// report that fits its fair share keeps its size and leaves the rest to larger ones,
/// which then share what remains equally (the previous even split when none is
/// small). Missing, unreadable and empty files get nothing.
fn shares(lens: &[usize], limit: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..lens.len()).collect();
    order.sort_by_key(|&i| lens[i]);
    let mut shares = vec![0; lens.len()];
    let mut remaining = limit;
    for (k, &i) in order.iter().enumerate() {
        let fair = remaining / (order.len() - k);
        let len = lens[i];
        if len >= fair {
            for &j in &order[k..] {
                shares[j] = fair;
            }
            break;
        }
        shares[i] = len;
        remaining -= len;
    }
    shares
}

/// Open every report before splitting the budget, and read those same handles.
/// Earlier path stamps select the round only; writers may have replaced empty or
/// missing files since then. Failed opens must not reserve bytes for unreadable text.
fn read_reports(lanes: Vec<Saved>, limit: usize) -> Vec<Saved> {
    let opened: Vec<_> = lanes
        .into_iter()
        .map(|mut saved| {
            let handle = saved.open();
            (saved, handle)
        })
        .collect();
    let lens: Vec<_> = opened
        .iter()
        .map(|(saved, _)| {
            saved
                .stamp
                .as_ref()
                .map_or(0, |stamp| usize::try_from(stamp.len).unwrap_or(usize::MAX))
        })
        .collect();
    opened
        .into_iter()
        .zip(shares(&lens, limit))
        .map(|((saved, handle), share)| saved.read(handle, share))
        .collect()
}

/// `branch`'s reviewers, with up to `limit` bytes of findings between those shown.
/// Empty when no reviewer has a findings file or an uncertain launch to report. Every
/// file is stamped first; only the findings shown are read.
fn saved(root: &Path, branch: &str, limit: usize) -> Lanes {
    let mut rounds = rounds(root, branch);
    let Some((_, latest)) = rounds.pop() else {
        return Lanes::default();
    };
    let read = |lanes| read_reports(lanes, limit);
    let round: Vec<Saved> = latest
        .into_iter()
        .map(|(file, started)| Saved::stamped(file, started, false))
        .collect();
    if round.iter().any(Saved::fresh) {
        return Lanes {
            round: read(round),
            earlier: None,
        };
    }
    // The latest round's own files may be much older than another round's findings
    // (its lanes may differ), so show whichever round's findings were written last.
    // A latest-round lane that hasn't written still holds the findings of the attempt
    // it replaced, which belong to that attempt's round.
    let mut earlier: BTreeMap<String, Vec<Saved>> = BTreeMap::new();
    for (key, lanes) in rounds {
        let written = lanes
            .into_iter()
            .map(|(file, started)| Saved::stamped(file, started, true))
            .filter(|s| s.stamp.is_some());
        earlier.entry(key).or_default().extend(written);
    }
    let mut own = vec![];
    for lane in round.iter().filter(|s| s.stamp.is_some()) {
        match &lane.started.previous {
            Some(previous) => {
                let mut started = lane.started.clone();
                started.base.clone_from(&previous.base);
                started.native = previous.native;
                started.previous = None;
                started.previous_findings = None;
                let held = Saved::stamped(lane.file.clone(), started, true);
                earlier
                    .entry(previous.round.clone())
                    .or_default()
                    .push(held);
            }
            None => own.push(lane.modified_ms),
        }
    }
    let own = own.into_iter().max();
    let shown = earlier
        .into_values()
        .filter_map(|mut lanes| {
            lanes.sort_by(|a, b| a.started.lane.cmp(&b.started.lane));
            Some((lanes.iter().map(|s| s.modified_ms).max()?, lanes))
        })
        .filter(|(modified, _)| own.is_none_or(|own| *modified > own))
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, lanes)| read(lanes));
    if shown.is_none()
        && !round
            .iter()
            .any(|s| s.stamp.is_some() || s.started.launch_error.is_some())
    {
        return Lanes::default();
    }
    match shown {
        Some(earlier) => Lanes {
            round,
            earlier: Some(earlier),
        },
        None => Lanes {
            round: read(round),
            earlier: None,
        },
    }
}

/// [`read`] up to `limit` bytes, combining the round's reviewers.
fn load(root: &Path, branch: &str, limit: usize) -> Option<Findings> {
    let lanes = saved(root, branch, limit);
    let round = &lanes.round;
    let shown = lanes.shown();
    let first = round.first()?;
    let started_ms = round.iter().map(|s| s.started.started_ms).min()?;
    // Covered only once every reviewer wrote findings, all for the same HEAD.
    let reviewed_head = round
        .iter()
        .all(|s| s.fresh() && s.started.head == first.started.head)
        .then(|| first.started.head.clone());
    // Findings without a reviewed HEAD are stale anyway; skip the worktree scan.
    let codex = round
        .iter()
        .any(|s| s.started.native == Some(context::ReviewStyle::Codex));
    let coverage = reviewed_head
        .is_some()
        .then(|| {
            git::worktrees(root)
                .into_iter()
                .find(|w| w.branch.as_deref() == Some(branch))
        })
        .flatten()
        .map(|w| git::review_coverage(Path::new(&w.path), started_ms).ok());
    // An unreadable worktree counts as both edited and uncovered.
    let edited_since_start = coverage.is_some_and(|c| c.is_none_or(|c| c.edited));
    let uncovered = reviewed_head.is_some()
        && codex
        && (round.iter().any(|s| s.started.excluded_untracked)
            || coverage.is_some_and(|c| c.is_none_or(|c| c.untracked)));
    let reviewers: Vec<Reviewer> = round
        .iter()
        .map(|s| Reviewer {
            lane: s.started.lane.clone(),
            finished: s.fresh(),
            verdict: s.fresh().then(|| s.verdict.clone()).flatten(),
            error: (!s.fresh())
                .then(|| s.started.launch_error.clone())
                .flatten(),
        })
        .collect();
    let verdict = match reviewers.as_slice() {
        [one] => one.verdict.clone(),
        _ => combined(reviewers.iter().map(|r| r.verdict.clone())),
    };
    let text = match shown {
        [one] => one.text.clone(),
        _ => shown
            .iter()
            .map(|s| format!("## Reviewer: {}\n\n{}", s.lane(), s.text.trim()))
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    Some(Findings {
        verdict,
        text,
        modified_ms: shown.iter().map(|s| s.modified_ms).max()?,
        reviewed_head,
        // The base of the findings shown, so the text never pairs with another round's base.
        base: shown.first().unwrap_or(first).started.base.clone(),
        round: first.started.round.clone(),
        started_ms,
        edited_since_start,
        uncovered,
        truncated: shown.iter().any(|s| s.truncated),
        reviewers,
    })
}

/// The branch checked out in `cwd`; `None` for a detached `HEAD`.
fn current_branch(cwd: &Path) -> Option<String> {
    git::run(git::git(cwd).args(["symbolic-ref", "--quiet", "--short", "HEAD"])).ok()
}

/// How much of the findings a fix agent's briefing inlines, split between reviewers
/// by [`shares`]. Changing it changes the briefing of fix sessions whose findings it
/// cuts, and with it their Restart fingerprint. Claude reads the briefing from a file
/// and Codex falls back to pointing at it, so this may exceed what the Review panel shows.
pub const HANDOFF_LIMIT: usize = 4 * crate::plans::PLAN_LIMIT;

/// A review session's own record: the folder it ran in (its worktree's top) and
/// the branch it recorded. A fix session records the same branch and runs in the
/// same worktree, perhaps in a subfolder, so it maps back to the same review. The
/// adapter reads either from the session service, never from the webview.
#[derive(Debug, Clone)]
pub struct Session {
    pub cwd: PathBuf,
    pub branch: Option<String>,
}

/// The reviewed worktree (canonical) and branch, checked without listing
/// worktrees: the worktree must still have the branch checked out.
fn target(session: &Session) -> Result<(PathBuf, &str)> {
    let branch = session
        .branch
        .as_deref()
        .context("This review predates recorded branches; start a new review")?;
    let worktree = session
        .cwd
        .canonicalize()
        .ok()
        .and_then(|cwd| git::nearest_repo(&cwd))
        .context("The reviewed worktree no longer exists")?;
    ensure!(
        current_branch(&worktree).as_deref() == Some(branch),
        "{branch} is no longer checked out in this worktree; switch back or review again"
    );
    Ok((worktree, branch))
}

fn no_findings(branch: &str) -> anyhow::Error {
    anyhow::anyhow!("No review findings are saved for {branch}")
}

// Polling findings should only deserialize records whose metadata changed. The key is
// the canonical folder plus branch identity, so other repositories/branches stay isolated.
#[derive(Default)]
struct RoundCache {
    stamps: Vec<(PathBuf, SystemTime, u64)>,
    records: Vec<(PathBuf, Started)>,
    last_used: Option<Instant>,
}

static ROUNDS: Mutex<BTreeMap<PathBuf, RoundCache>> = Mutex::new(BTreeMap::new());

const ROUND_CACHE_LIMIT: usize = 128;

fn cached_round(cache: &mut BTreeMap<PathBuf, RoundCache>, key: PathBuf) -> &mut RoundCache {
    // Keep polling cheap without retaining every project/branch ever opened.
    if !cache.contains_key(&key)
        && cache.len() >= ROUND_CACHE_LIMIT
        && let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
    {
        cache.remove(&oldest);
    }
    let entry = cache.entry(key).or_default();
    entry.last_used = Some(Instant::now());
    entry
}

/// The findings file and attempt of each of `branch`'s reviewers, grouped by round
/// (sidecars from before rounds were recorded stand alone), each sorted by lane, in
/// the order their latest attempts started: the last is the latest round. Only
/// sidecars that really are `branch`'s, at the path their own branch and lane give,
/// count. One folder scan; unchanged sidecars aren't read again.
fn rounds(root: &Path, branch: &str) -> Vec<(String, Vec<(PathBuf, Started)>)> {
    let Some(folder) = existing_dir(root) else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return vec![];
    };
    let prefix = name(branch);
    let mut stamps: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") || !of_branch(&path, &prefix) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, metadata.modified().ok()?, metadata.len()))
        })
        .collect();
    stamps.sort_by(|a, b| a.0.cmp(&b.0));
    let mut cache = ROUNDS.lock().unwrap_or_else(PoisonError::into_inner);
    let entry = cached_round(&mut cache, folder.join(&prefix));
    if entry.stamps != stamps {
        entry.records = stamps
            .iter()
            .filter_map(|(path, _, _)| {
                let started: Started = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
                if started.branch != branch {
                    return None;
                }
                let findings = named_lane(&folder, &prefix, started.lane.as_deref());
                (findings.with_extension("json") == *path).then_some((findings, started))
            })
            .collect();
        entry.stamps = stamps;
    }
    let all = entry.records.clone();
    drop(cache);
    let mut rounds: BTreeMap<String, Vec<(PathBuf, Started)>> = BTreeMap::new();
    for (file, started) in all {
        rounds
            .entry(round_key(&started))
            .or_default()
            .push((file, started));
    }
    let mut rounds: Vec<_> = rounds.into_iter().collect();
    for (_, lanes) in &mut rounds {
        lanes.sort_by(|a, b| a.1.lane.cmp(&b.1.lane));
    }
    rounds.sort_by_key(|(_, lanes)| lanes.iter().map(|(_, s)| s.started_ms).max());
    rounds
}

/// Whether `branch` has nonempty findings saved, without reading their
/// freshness or more than the start of each file.
fn has_findings(worktree: &Path, branch: &str) -> bool {
    saved(worktree, branch, 4096)
        .shown()
        .iter()
        // A long file counts even if it were blank throughout; `handoff` still checks.
        .any(|s| s.truncated || !s.text.trim().is_empty())
}

/// The task a fix for review `session` runs in: the stored task holding the
/// reviewed worktree, else `None` for the project folder `root` sits in. Makes
/// [`handoff`]'s checks first, so a refused fix changes nothing.
///
/// # Errors
/// Fails as [`handoff`] would, or when neither the project folder nor a task
/// holds the reviewed worktree.
pub fn fix_task(root: &Path, session: &Session) -> Result<Option<String>> {
    let (worktree, branch) = target(session)?;
    ensure!(has_findings(&worktree, branch), no_findings(branch));
    git::run(git::git(&worktree).args(["rev-parse", "--verify", "--quiet", "HEAD"]))
        .with_context(|| format!("{branch} has no commit to fix yet"))?;
    // The store is per repository, so a match is also in `root`'s repository.
    if let Some(task) = crate::tasks::stored_at(root, &worktree)? {
        return Ok(Some(task.id));
    }
    ensure!(
        git::repo_root(root).as_ref() == Some(&worktree),
        "Add this worktree as a task first"
    );
    Ok(None)
}

/// Inline review `session`'s findings for a fix agent launched at `root`. Grants
/// no folders: the reviews folder would be writable to the agent.
///
/// # Errors
/// Fails for a session without a recorded branch, when `root` isn't in the
/// reviewed worktree, that worktree no longer has the branch checked out, or it
/// has no saved findings.
pub fn handoff(root: &Path, session: &Session) -> Result<context::ContextSection> {
    let (worktree, branch) = target(session)?;
    ensure!(
        git::repo_root(root).as_ref() == Some(&worktree),
        "This launch isn't in the reviewed worktree"
    );
    let lanes = saved(&worktree, branch, HANDOFF_LIMIT);
    let body = findings_body(lanes.shown(), branch, true).ok_or_else(|| no_findings(branch))?;
    Ok(context::ContextSection {
        title: "Review findings".into(),
        body,
    })
}

/// Inline findings for a merge without fix instructions or a worktree status scan.
/// The caller has already validated the source worktree and its HEAD.
#[must_use]
pub fn merge_handoff(root: &Path, branch: &str, head: &str) -> Option<context::ContextSection> {
    let lanes = saved(root, branch, HANDOFF_LIMIT);
    let body = findings_body(lanes.shown(), branch, false)?;
    let modified_ms = lanes.shown().iter().map(|s| s.modified_ms).max()?;
    let matches = lanes
        .round
        .iter()
        .all(|s| s.fresh() && s.started.head == head);
    Some(context::ContextSection {
        title: "Review findings".into(),
        body: format!(
            "Review saved at Unix milliseconds: {modified_ms}\nReviewed HEAD matches source HEAD: {matches}\n\nRead these findings and mention unresolved findings in your report. Do not fix them unless the merge requires it.\n\n{body}"
        ),
    })
}

fn findings_body(all: &[Saved], branch: &str, for_fix: bool) -> Option<String> {
    // Keep a cut report's file reference even when the prefix has no visible text.
    let lanes: Vec<_> = all
        .iter()
        .filter(|s| s.truncated || !s.text.trim().is_empty())
        .collect();
    let first = lanes.first()?;
    // Only facts fixed by the findings themselves, so the briefing (and with it Restart's
    // fingerprint, which a Codex command carries inline) stays the same while the fix works.
    let reviewed = |s: &Saved| {
        if s.fresh() {
            let head = &s.started.head;
            format!(
                "HEAD {}, as it was when the review started",
                head.get(..7).unwrap_or(head)
            )
        } else {
            "an earlier attempt; a newer review hasn't written findings yet".into()
        }
    };
    let findings = |s: &Saved| {
        // Native normalization and UTF-8 boundaries make offsets into the original
        // file unreliable. Ask for the whole report instead.
        let cut = if s.truncated {
            format!(
                "\n\n[The findings are truncated; read the complete report from the beginning in {}; read it only, and ask the user if you can't.]",
                s.file.display()
            )
        } else {
            String::new()
        };
        format!("{}{cut}", s.text.trim())
    };
    let body = match lanes.as_slice() {
        [one] => format!(
            "Branch: {branch}\nBase: {}\nReviewed: {}\nFindings file: {}\n\nCommits since that HEAD and uncommitted changes (`git status`) may already address some findings.\n\n{}",
            one.started.base,
            reviewed(one),
            one.file.display(),
            findings(one)
        ),
        _ => format!(
            "Branch: {branch}\nBase: {}\n\n{} reviewers reviewed this branch independently, so their findings may overlap{}. Commits since the reviewed HEAD and uncommitted changes (`git status`) may already address some findings.\n\n{}",
            first.started.base,
            lanes.len(),
            if for_fix { ": fix each issue once" } else { "" },
            lanes
                .iter()
                .map(|s| format!(
                    "### Reviewer: {}\nReviewed: {}\nFindings file: {}\n\n{}",
                    s.lane(),
                    reviewed(s),
                    s.file.display(),
                    findings(s)
                ))
                .collect::<Vec<_>>()
                .join("\n\n")
        ),
    };
    Some(body)
}

/// Remove a branch's findings and sidecars, every reviewer's.
///
/// # Errors
/// Fails for a non-repository root or deletion errors.
pub fn remove(root: &Path, branch: &str) -> Result<()> {
    let file = file(root, branch)?;
    let prefix = name(branch);
    // Every reviewer's findings path, also those whose findings were never written.
    let mut lanes = std::collections::BTreeSet::from([file.clone()]);
    if let Some(folder) = file.parent()
        && let Ok(entries) = std::fs::read_dir(folder)
    {
        lanes.extend(
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|ext| ext == "md" || ext == "json")
                        && of_branch(path, &prefix)
                })
                .map(|path| path.with_extension("md")),
        );
    }
    // Keep the branch identity for a later cleanup retry if deleting findings fails.
    let findings = lanes.iter().cloned();
    let sidecars = lanes.iter().map(|f| f.with_extension("json"));
    for path in findings.chain(sidecars) {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    if let Some(folder) = file.parent() {
        ROUNDS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&folder.join(prefix));
    }
    Ok(())
}

/// Delete saved reviews only when their recorded local branch ref is gone.
/// A review that can't be deleted is left for the next prune.
///
/// # Errors
/// Fails for an unreadable folder or ref listing.
pub fn prune(root: &Path) -> Result<()> {
    let Some(folder) = existing_dir(root) else {
        return Ok(());
    };
    // A failed ref listing must never be interpreted as deleted branches.
    let branches = git::branches(root)?;
    for entry in std::fs::read_dir(&folder)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(started) = serde_json::from_slice::<Started>(&bytes) else {
            continue;
        };
        // Never trust a sidecar's branch to remove a different artifact.
        if path != in_lane(&folder, &started.branch, started.lane.as_deref()).with_extension("json")
        {
            continue;
        }
        if !branches.contains(&started.branch) {
            let _ = remove(root, &started.branch);
        }
    }
    Ok(())
}

/// Grant only the registered review worktree and existing findings folder on resume.
///
/// # Errors
/// Fails for a missing, unregistered or foreign worktree, or missing findings folder.
pub fn resume_roots(root: &Path, spec: &SessionSpec) -> Result<Vec<PathBuf>> {
    let path = spec.cwd.canonicalize()?;
    ensure!(
        git::worktrees(root)
            .iter()
            .any(|t| Path::new(&t.path) == path),
        "The review worktree at {} is no longer registered",
        path.display()
    );
    owned_dirs(&path, &git::common_dir(root)?.canonicalize()?)?;
    Ok(vec![
        path,
        existing_dir(root).context("The reviews folder is missing")?,
    ])
}

#[cfg(test)]
mod tests {
    #[test]
    fn codex_reports_convert_to_the_findings_contract() {
        assert!(
            from_codex("No findings. The patch is correct.")
                .1
                .unwrap()
                .clean
        );
        let raw = "The patch is incorrect.\n\nReview comments:\n\n- [P0] Critical failure — src/a.rs:1-2\n  Evidence.\n- [P1] High impact — src/b.rs:3-4\n- [P2] Medium impact — src/c.rs:5-6\n- [P3] Low impact — src/d.rs:7-8\n- [P2] Another issue — src/e.rs:9-9";
        let (converted, parsed) = from_codex(raw);
        assert!(converted.starts_with(
            "Verdict: issues\nCounts: {\"critical\":1,\"high\":1,\"medium\":2,\"low\":1}\n\n"
        ));
        assert!(converted.contains("- [high] High impact — src/b.rs:3-4"));
        assert!(!converted.contains("[P"));
        assert_eq!(
            parsed.unwrap().counts,
            Severities {
                critical: 1,
                high: 1,
                medium: 2,
                low: 1
            }
        );
        assert_eq!(from_codex(""), (String::new(), None));
        assert!(from_codex(" \n").1.is_none());
    }

    #[test]
    fn codex_unknown_failed_or_incomplete_reports_never_read_as_clean() {
        for report in [
            "",
            "Review interrupted",
            "Error: authentication failed",
            "- Fix the race in src/main.rs:12",
            "No findings yet; review interrupted.",
            "Review failed\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\nVerdict: clean",
            "No findings because I could not access the repository.",
            "Verdict: clean\nCounts: broken\nNo findings.",
        ] {
            assert!(from_codex(report).1.is_none(), "{report}");
        }
        let report = "Verdict: clean\nCounts: {\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}\nUntagged finding";
        let (text, parsed) = from_codex(report);
        assert_eq!(text, report);
        let parsed = parsed.unwrap();
        assert!(!parsed.clean);
        assert_eq!(parsed.counts.high, 1);
        let clean = "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\nNo findings.";
        assert!(from_codex(clean).1.unwrap().clean);
    }

    #[test]
    fn native_codex_clean_conclusions_are_explicit_and_complete() {
        for report in [
            "No findings.",
            "The patch is correct.",
            "I did not find any actionable correctness regressions in the diff. The changes preserve behavior.",
            "I didn't find any concrete, actionable bugs introduced by these changes.",
            "I found no issues in the reviewed changes.",
            "I did not identify any actionable issues introduced by this patch.",
            "No actionable issues were found in the diff.",
            "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\nThe retry handles the failed request correctly.",
            "## Verdict: clean\n\n**Counts:** {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}",
        ] {
            assert!(from_codex(report).1.unwrap().clean, "{report}");
        }
        assert!(codex_report("No findings.", true).1.is_none());
        let report = "No findings.\n- [P1] Lost writes — file.txt:1";
        assert_eq!(from_codex(report).1.unwrap().counts.high, 1);
        // Qualified conclusions describe a problem in prose: no verdict, never clean.
        for report in [
            "The patch is correct in most respects, but the retry loop never terminates when the server returns 503 (src/net.rs:40).",
            "The patch is correct in most respects.",
            "No findings. However, the retry loop never terminates (src/net.rs:40).",
            "I did not find any issues, except that the cache is never invalidated.",
        ] {
            assert!(from_codex(report).1.is_none(), "{report}");
        }
        // Quoted code isn't the reviewer reporting an error.
        for report in [
            "No findings. The new handler correctly strips the `error:` prefix from log lines.",
            "No findings.\n\n```\nerror: could not access config\n```",
        ] {
            assert!(from_codex(report).1.unwrap().clean, "{report}");
        }
        assert!(from_codex("error: could not reach the model").1.is_none());
    }

    #[test]
    fn codex_tags_leave_code_alone() {
        let report = "- [P2] Off by one — src/a.rs:3\n  `let x = weights[P1];`\n```\nfoo[P0]\n```";
        let (text, verdict) = from_codex(report);
        assert!(text.contains("- [medium] Off by one"));
        assert!(text.contains("`let x = weights[P1];`"));
        assert!(text.contains("foo[P0]"));
        let verdict = verdict.unwrap();
        assert_eq!(
            (
                verdict.counts.medium,
                verdict.counts.high,
                verdict.counts.critical
            ),
            (1, 0, 0)
        );
    }

    #[test]
    fn truncated_multi_reviewer_reports_keep_totals_and_codex_severities() {
        let f = Fixture::new();
        for (lane, command) in [("codex", "codex"), ("claude", "claude"), ("other", "aider")] {
            let terminal = serde_json::from_value(serde_json::json!({
                "id": lane, "name": lane, "kind": "agent", "command": command,
            }))
            .unwrap();
            let request = ReviewRequest {
                lane: Some(lane.into()),
                round: Some("large".into()),
                ..f.request.clone()
            };
            let prepared = prepare(&f.project, &request, &terminal, &AllowAll, None).unwrap();
            let path = lane_file(&f.dir, &f.request.branch, Some(lane)).unwrap();
            let tag = if command == "codex" { "P1" } else { "high" };
            fs::write(&path, format!("Verdict: issues\nCounts: {{\"critical\":0,\"high\":3,\"medium\":0,\"low\":0}}\n- [{tag}] Lost writes — file.txt:1\n{}", "Evidence.\n".repeat(crate::plans::PLAN_LIMIT))).unwrap();
            let started: Started =
                serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
            fs::File::open(&path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(started.started_ms + 10))
                .unwrap();
            context::remove_owned_briefing_file(
                &context::owned_briefing(&prepared.job.spec).unwrap(),
            );
        }
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert!(findings.truncated);
        assert_eq!(findings.verdict.unwrap().counts.high, 3);
        assert!(
            findings
                .reviewers
                .iter()
                .all(|r| r.finished && r.verdict.is_some())
        );
        assert!(findings.text.contains("[high] Lost writes"));
        assert!(!findings.text.contains("[P1]"));
    }

    #[test]
    fn unwritten_attempts_preserve_the_reports_actual_style_and_round() {
        for original in ["codex", "aider"] {
            let f = Fixture::new();
            f.prepare(original).unwrap();
            f.save(if original == "codex" { "- [P1] Original finding — file.txt:1" } else { "Verdict: issues\nCounts: {\"critical\":0,\"high\":2,\"medium\":0,\"low\":0}\nOriginal finding" }, true);
            let before = read(&f.dir, &f.request.branch).unwrap();
            for command in ["claude", "codex", "aider", "claude"] {
                f.prepare(command).unwrap();
                let findings = read(&f.dir, &f.request.branch).unwrap();
                assert_eq!(findings.text, before.text);
                assert!(findings.verdict.is_none());
            }
        }
    }

    #[test]
    fn branches_without_a_checked_out_worktree_keep_review_coverage() {
        for command in ["claude", "codex", "aider"] {
            let f = Fixture::new();
            f.prepare(command).unwrap();
            f.save(
                "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}",
                true,
            );
            git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
            let findings = read(&f.dir, &f.request.branch).unwrap();
            assert!(findings.reviewed_head.is_some());
            assert!(!findings.edited_since_start, "{command}");
            assert!(!findings.uncovered, "{command}");
        }
    }

    #[test]
    fn native_targets_use_commit_ids_and_codex_receives_auto_briefing() {
        let mut f = Fixture::new();
        f.request.base = "fix(ui)%USERNAME%".into();
        git::run(git::git(&f.dir).args(["branch", &f.request.base, "main"])).unwrap();
        let base = git::run(git::git(&f.dir).args(["rev-parse", "main"])).unwrap();
        let auto = context::AutoBrief {
            goal: "Fix lost writes".into(),
            fix_floor: Some(Severity::High),
            effort_note: "Targeted".into(),
            commit: false,
        };
        for command in ["claude", "codex -p yolo"] {
            let terminal = serde_json::from_value(serde_json::json!({"id":"reviewer", "name":"Review", "kind":"agent", "command":command})).unwrap();
            let prepared =
                prepare(&f.project, &f.request, &terminal, &AllowAll, Some(&auto)).unwrap();
            let spec = &prepared.job.spec;
            if command.starts_with("codex") {
                assert!(
                    spec.command
                        .contains(&format!("--base {}", context::quote_argument(&base)))
                );
                assert!(spec.command.contains("Fix lost writes"));
                assert!(spec.command.contains("leave lower ones listed"));
                assert!(spec.command.contains("Do not edit source files"));
                assert!(spec.command.contains("exec --sandbox read-only review"));
            } else {
                assert!(spec.command.contains(&format!("high {base}...HEAD")));
                assert!(!spec.command.contains("fix(ui)"));
            }
            prepared.rollback();
        }
    }

    #[test]
    fn codex_does_not_claim_untracked_files_even_when_they_predate_review() {
        for command in ["codex", "claude"] {
            let f = Fixture::new();
            let untracked = f.dir.join("untracked.txt");
            fs::write(&untracked, "not in the branch diff").unwrap();
            fs::File::open(&untracked)
                .unwrap()
                .set_modified(UNIX_EPOCH)
                .unwrap();
            f.prepare(command).unwrap();
            f.save(
                "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}",
                true,
            );
            let findings = read(&f.dir, &f.request.branch).unwrap();
            assert!(findings.reviewed_head.is_some());
            // Uncovered files block automatic merging but don't make the findings stale.
            assert!(!findings.edited_since_start, "{command}");
            assert_eq!(findings.uncovered, command == "codex");
            if command == "codex" {
                // The attempt still left out what was untracked at its launch.
                fs::remove_file(&untracked).unwrap();
                assert!(read(&f.dir, &f.request.branch).unwrap().uncovered);
            }
        }
    }

    #[test]
    fn codex_detects_backdated_untracked_files_added_after_launch() {
        let f = Fixture::new();
        f.prepare("codex").unwrap();
        f.save(
            "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}",
            true,
        );
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert!(!findings.edited_since_start && !findings.uncovered);
        let path = f.dir.join("backdated.txt");
        fs::write(&path, "omitted").unwrap();
        fs::File::open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH)
            .unwrap();
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert!(!findings.edited_since_start);
        assert!(findings.uncovered);
    }

    #[test]
    fn legacy_patchbay_findings_keep_their_counts_when_first_codex_attempt_starts() {
        let f = Fixture::new();
        let path = file(&f.dir, &f.request.branch).unwrap();
        dir(&f.dir).unwrap();
        let legacy = "Verdict: issues\nCounts: {\"critical\":0,\"high\":2,\"medium\":0,\"low\":0}\nTwo untagged findings from an older version.";
        fs::write(&path, legacy).unwrap();
        f.prepare("codex").unwrap();
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, legacy);
        assert!(findings.verdict.is_none());
        assert!(findings.reviewed_head.is_none());
        assert_eq!(verdict(&findings.text).unwrap().counts.high, 2);
        assert!(fix_body(&f).contains(legacy));
    }

    #[test]
    fn prepare_records_native_styles_and_older_sidecars_default_to_patchbay() {
        let f = Fixture::new();
        for (command, native) in [
            ("claude", Some(context::ReviewStyle::Claude)),
            ("codex --model review", Some(context::ReviewStyle::Codex)),
            ("aider", None),
            ("codex exec", None),
            ("claude && echo done", None),
        ] {
            let prepared = f.prepared(command).unwrap();
            let path = file(&f.dir, &f.request.branch)
                .unwrap()
                .with_extension("json");
            let bytes = fs::read(path).unwrap();
            let started: Started = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(started.native, native);
            let mut old = serde_json::to_value(&started).unwrap();
            old.as_object_mut().unwrap().remove("native");
            assert_eq!(serde_json::from_value::<Started>(old).unwrap().native, None);
            prepared.rollback();
        }
    }

    #[test]
    fn mixed_native_and_patchbay_lanes_combine_and_hand_off_normalized_findings() {
        let f = Fixture::new();
        for (lane, command, text) in [
            (
                "claude",
                "claude",
                "Verdict: issues\n[high] Claude finding — file.txt:1",
            ),
            (
                "codex",
                "codex",
                "The patch is incorrect.\n\n- [P2] Codex finding — file.txt:1-1",
            ),
            ("other", "aider", "Verdict: clean\nNo findings."),
        ] {
            let terminal = serde_json::from_value(serde_json::json!({
                "id": lane, "name": lane, "kind": "agent", "command": command,
            }))
            .unwrap();
            let request = ReviewRequest {
                lane: Some(lane.into()),
                round: Some("mixed".into()),
                ..f.request.clone()
            };
            let prepared = prepare(&f.project, &request, &terminal, &AllowAll, None).unwrap();
            let path = lane_file(&f.dir, &f.request.branch, Some(lane)).unwrap();
            fs::write(&path, text).unwrap();
            let started: Started =
                serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
            fs::File::open(&path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(started.started_ms + 10))
                .unwrap();
            context::remove_owned_briefing_file(
                &context::owned_briefing(&prepared.job.spec).unwrap(),
            );
        }
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.round, "mixed");
        assert_eq!(findings.reviewers.len(), 3);
        assert!(findings.reviewers.iter().all(|r| r.finished));
        let verdict = findings.verdict.unwrap();
        assert!(!verdict.clean);
        assert_eq!(
            verdict.counts,
            Severities {
                high: 1,
                medium: 1,
                ..Severities::default()
            }
        );
        assert!(findings.reviewed_head.is_some());
        let handoff = fix_body(&f);
        assert!(handoff.contains("[high] Claude finding"));
        assert!(handoff.contains("[medium] Codex finding"));
        assert!(!handoff.contains("[P2]"));
    }

    #[test]
    fn codex_saved_findings_feed_verdict_and_fix_and_preserve_earlier_style() {
        let f = Fixture::new();
        f.prepare("codex").unwrap();
        assert!(read(&f.dir, &f.request.branch).is_none());
        f.save("", true);
        assert!(read(&f.dir, &f.request.branch).unwrap().verdict.is_none());
        f.save(
            "The patch is incorrect.\n\n- [P1] Fix this — file.txt:1-1\n  Evidence.",
            true,
        );
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.verdict.unwrap().counts.high, 1);
        assert!(fix_body(&f).contains("[high] Fix this"));
        assert!(!fix_body(&f).contains("[P1]"));
        let capped = load(&f.dir, &f.request.branch, 5).unwrap();
        assert!(capped.truncated);
        assert!(capped.verdict.is_none());
        // Reusing a lane with another provider still shows its earlier native findings.
        f.prepare("claude").unwrap();
        let previous = read(&f.dir, &f.request.branch).unwrap();
        assert!(previous.verdict.is_none());
        assert!(previous.text.contains("[high] Fix this"));
        f.save("Verdict: issues\n[medium] Claude finding", true);
        f.prepare("codex").unwrap();
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .text
                .contains("[medium] Claude finding")
        );
        f.save("Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\nNo findings.", true);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .verdict
                .unwrap()
                .clean
        );
    }

    #[test]
    fn reported_counts_and_tagged_findings_both_block() {
        let findings = "- [low] Minor issue\n- **[high]** src/db.rs:42 Data loss";
        let parsed = verdict(&format!(
            "Verdict: issues\nCounts: {{\"critical\":0,\"high\":1,\"medium\":0,\"low\":1}}\n{findings}"
        ))
        .unwrap();
        assert!(!parsed.clean);
        assert_eq!(parsed.counts.high, 1);
        assert_eq!(parsed.counts.low, 1);
        // Tagged findings the reported counts leave out still count.
        let parsed = verdict(&format!(
            "Verdict: clean\nCounts: {{\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}}\n- [critical] Lost writes\n{findings}"
        ))
        .unwrap();
        assert!(!parsed.clean);
        assert_eq!(
            parsed.counts,
            Severities {
                critical: 1,
                high: 1,
                low: 1,
                ..Severities::default()
            }
        );
        // Reported totals above the tagged ones count too, even with a clean verdict.
        let parsed = verdict(
            "Verdict: clean\nCounts: {\"critical\":0,\"high\":2,\"medium\":0,\"low\":0}\n- [high] Bug",
        )
        .unwrap();
        assert!(!parsed.clean);
        assert_eq!(parsed.counts.high, 2);
        let clean = verdict(
            "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\nNo findings.",
        )
        .unwrap();
        assert!(clean.clean);
        assert!(
            !verdict("Verdict: issues\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}")
                .unwrap()
                .clean
        );
    }

    #[test]
    fn counts_are_optional_and_read_leniently_but_never_malformed() {
        assert!(verdict("Verdict: clean\nNo findings.").unwrap().clean);
        assert_eq!(
            verdict("Verdict: issues\n- [high] Bug")
                .unwrap()
                .counts
                .high,
            1
        );
        for text in [
            "\u{feff}Verdict: issues\nCounts: {\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}",
            "# Review\n\n**Verdict:** issues\n\n**Counts:** `{\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}`",
            "Verdict: issues\n\n\ncounts : {\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}",
        ] {
            assert_eq!(verdict(text).unwrap().counts.high, 1, "{text}");
        }
        assert!(
            verdict("Verdict: maybe\nCounts: {\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}")
                .is_none()
        );
        for counts in [
            "{}",
            r#"{"critical":0,"high":1,"medium":0}"#,
            r#"{"critical":0,"high":1,"medium":0,"low":0,"extra":1}"#,
            r#"{"critical":0,"high":0,"high":1,"medium":0,"low":0}"#,
            r#"{"critical":0,"high":-1,"medium":0,"low":0}"#,
            r#"{"critical":0,"high":1.5,"medium":0,"low":0}"#,
            r#"{"critical":0,"high":4294967296,"medium":0,"low":0}"#,
            r#"{"critical":0,"high":"1","medium":0,"low":0}"#,
            "not json",
        ] {
            assert!(
                verdict(&format!("Verdict: clean\nCounts: {counts}")).is_none(),
                "{counts}"
            );
        }
    }

    #[test]
    fn counts_lines_away_from_the_verdict_are_prose() {
        // Without totals beside the verdict, tags decide, whatever later lines say.
        for later in [
            "Counts: not json",
            "**Counts:** 2 high, 1 low",
            r#"Counts: {"critical":0,"high":0,"medium":0,"low":0}"#,
            r#"Counts: {"critical":3,"high":0,"medium":0,"low":0}"#,
        ] {
            let text = format!("Verdict: issues\nSummary first.\n{later}\n- [high] Bug");
            let parsed = verdict(&text).unwrap();
            assert_eq!(
                parsed.counts,
                Severities {
                    high: 1,
                    ..Severities::default()
                },
                "{later}"
            );
        }
        let text = "Verdict: clean\nCounts: {\"critical\":0,\"high\":0,\"medium\":0,\"low\":0}\n\nCounts: not json\nNo findings.";
        assert!(verdict(text).unwrap().clean);
    }

    #[test]
    fn markdown_does_not_hide_blocking_findings() {
        for line in [
            "- [ ] [high] Bug",
            "* [x] **[high]** Bug",
            "1. [X] [**high**] Bug",
            "| [high] | Bug |",
            "| [**high**] | Bug |",
            "| 1 | [**high**] | Bug |",
            "| Bug mentions [low] | [high] |",
            "[**high**] Bug",
            "- [ ] [__high__] Bug",
        ] {
            let parsed = super::verdict(&format!("Verdict: clean\n{line}")).unwrap();
            assert_eq!(parsed.counts.high, 1, "{line}");
        }
        let parsed = super::verdict(
            "Verdict: clean\n| [high] |\n| [**high**] | [low] |\n- [ ] [high]\n\
             ## Severity legend\n| [high] | Priority definition |\n\
             ## Examples\n```markdown\n- [ ] [high] Example\n```",
        )
        .unwrap();
        assert_eq!(parsed.counts, super::Severities::default());
    }

    #[test]
    fn severity_count_tables_are_not_findings() {
        for row in [
            "| [high] | 0 |",
            "| [**critical**] | 2 |",
            "| 0 | [medium] |",
            "| 1 | [low] | 0 |",
            "| [high] | 0 | 0% |",
        ] {
            let parsed = super::verdict(&format!(
                "Verdict: clean\n| Severity | Count |\n| --- | ---: |\n{row}"
            ))
            .unwrap();
            assert_eq!(parsed.counts, super::Severities::default(), "{row}");
        }
        let parsed = super::verdict(
            "Verdict: issues\n| [high] | 0 |\n| 1 | [high] | Bug |\n| [low] | Minor issue |",
        )
        .unwrap();
        assert_eq!(parsed.counts.high, 1);
        assert_eq!(parsed.counts.low, 1);
    }

    #[test]
    fn bold_list_numbers_do_not_hide_blocking_findings() {
        for line in [
            "**1.** [high] Bug",
            "**2)** **[high]** Bug",
            "- **[high]** Bug",
            "__1.__ [high] Bug",
            "`1.` [high] Bug",
        ] {
            let parsed = super::verdict(&format!("Verdict: clean\n{line}")).unwrap();
            assert_eq!(parsed.counts.high, 1, "{line}");
        }
    }

    #[test]
    fn parses_structured_verdicts_leniently_and_requires_the_header() {
        use super::verdict;
        assert!(verdict("  VERDICT : ClEaN \nNo findings.").unwrap().clean);
        let issues =
            verdict("Verdict: issues\n- [Critical] one\n- [HIGH] two\n[medium] three\n[low] four")
                .unwrap();
        assert!(!issues.clean);
        assert_eq!(
            issues.counts,
            super::Severities {
                critical: 1,
                high: 1,
                medium: 1,
                low: 1
            }
        );
        assert!(verdict("No findings").is_none());
        assert!(verdict("Verdict: maybe").is_none());
        assert!(verdict("# Findings\n**Verdict:** clean").unwrap().clean);
        let parsed = verdict("# Review\n**Verdict:** issues\nLegend: [critical], [high], [medium], [low]\n[critical] [high] [medium] [low]\n1. **[low]** finding mentions [critical]\n### [medium] another finding\nExplanation mentions [high]").unwrap();
        assert_eq!(
            parsed.counts,
            Severities {
                low: 1,
                medium: 1,
                ..Severities::default()
            }
        );
        let parsed = verdict("# Review\n**Verdict**: **issues**\n## Severity legend\n- [critical] highest priority\n- [low] minor\n## Findings\n1. [medium] file.rs:1: bug mentioning [critical]\n```text\n[high] example\n```").unwrap();
        assert_eq!(
            parsed.counts,
            Severities {
                medium: 1,
                ..Severities::default()
            }
        );
        let parsed = verdict("Verdict: issues\n[low] [critical] file.rs:1: finding\n[critical], [high], [medium] or [low]").unwrap();
        assert_eq!(
            parsed.counts,
            Severities {
                low: 1,
                ..Severities::default()
            }
        );
        assert!(verdict("Verdict: clean.").unwrap().clean);
        assert!(!verdict("Verdict: issues (2)").unwrap().clean);
        let parsed = verdict("Verdict: issues\n### [high] Chart legend overlaps axis\n### Legend\n[low] example tag\n## Findings\n- [medium] real").unwrap();
        assert_eq!(
            parsed.counts,
            Severities {
                high: 1,
                medium: 1,
                ..Severities::default()
            }
        );
    }

    use super::*;
    use crate::policy::AllowAll;
    use std::fs;
    use std::time::{Duration, UNIX_EPOCH};

    struct Fixture {
        dir: PathBuf,
        project: Project,
        request: ReviewRequest,
    }
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("patchbay-review-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            git::run(git::git(&dir).args(["init", "-q", "-b", "main"])).unwrap();
            git::run(git::git(&dir).args(["config", "user.name", "Review test"])).unwrap();
            git::run(git::git(&dir).args(["config", "user.email", "review@patchbay.invalid"]))
                .unwrap();
            git::run(git::git(&dir).args(["config", "commit.gpgsign", "false"])).unwrap();
            fs::write(dir.join("file.txt"), "base\n").unwrap();
            git::run(git::git(&dir).args(["add", "."])).unwrap();
            git::run(git::git(&dir).args(["commit", "-qm", "base"])).unwrap();
            git::run(git::git(&dir).args(["checkout", "-qb", "feature/a"])).unwrap();
            let dir = dir.canonicalize().unwrap();
            let project = Project {
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Review test".into(),
                root: dir.to_string_lossy().into(),
                components: vec![],
                links: vec![],
                groups: vec![],
            };
            let request = ReviewRequest {
                worktree: project.root.clone(),
                branch: "feature/a".into(),
                base: "main".into(),
                lane: None,
                round: None,
            };
            Self {
                dir,
                project,
                request,
            }
        }
        fn prepared(&self, command: &str) -> Result<Prepared> {
            let terminal = serde_json::from_value(serde_json::json!({"id":"agent", "name":"Agent", "kind":"agent", "command":command})).unwrap();
            prepare(&self.project, &self.request, &terminal, &AllowAll, None)
        }
        fn prepare(&self, command: &str) -> Result<AgentJob> {
            self.prepared(command).map(|p| p.job)
        }
        fn save(&self, text: &str, after: bool) {
            let path = file(&self.dir, &self.request.branch).unwrap();
            let sidecar: Started =
                serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            let time = if after {
                sidecar.started_ms + 10
            } else {
                sidecar.started_ms.saturating_sub(10)
            };
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(time))
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn session(cwd: &Path, branch: Option<&str>) -> Session {
        Session {
            cwd: cwd.into(),
            branch: branch.map(Into::into),
        }
    }

    /// The fix briefing for a review of `branch` in the worktree at `dir`.
    fn fix(dir: &Path, branch: &str) -> Result<context::ContextSection> {
        handoff(dir, &session(dir, Some(branch)))
    }

    /// A linked worktree of `main` with findings saved by a review there.
    fn reviewed_linked(f: &Fixture) -> PathBuf {
        let worktree = f.dir.join("linked");
        git::run(git::git(&f.dir).args([
            "worktree",
            "add",
            "-q",
            worktree.to_str().unwrap(),
            "main",
        ]))
        .unwrap();
        let request = ReviewRequest {
            worktree: worktree.display().to_string(),
            branch: "main".into(),
            base: f.request.branch.clone(),
            lane: None,
            round: None,
        };
        let terminal = serde_json::from_value(
            serde_json::json!({"id":"review", "name":"Review", "kind":"agent", "command":"claude"}),
        )
        .unwrap();
        prepare(&f.project, &request, &terminal, &AllowAll, None).unwrap();
        let path = file(&worktree, "main").unwrap();
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        fs::write(&path, "Linked finding").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(started.started_ms + 10))
            .unwrap();
        worktree
    }

    fn fix_body(f: &Fixture) -> String {
        fix(&f.dir, &f.request.branch).unwrap().body
    }

    #[test]
    fn handoff_omits_missing_blank_and_detached_findings() {
        let f = Fixture::new();
        assert!(fix(&f.dir, &f.request.branch).is_err());
        assert!(existing_dir(&f.dir).is_none());
        f.prepare("claude").unwrap();
        assert!(fix(&f.dir, &f.request.branch).is_err());
        f.save(" \n", true);
        assert!(fix(&f.dir, &f.request.branch).is_err());
        f.save("P2 file.txt:1: Fix this", true);
        git::run(git::git(&f.dir).args(["checkout", "--detach", "-q"])).unwrap();
        assert!(fix(&f.dir, &f.request.branch).is_err());
    }

    #[test]
    fn handoff_refuses_another_checked_out_branch() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        let error = fix(&f.dir, &f.request.branch).unwrap_err();
        assert!(error.to_string().contains("no longer checked out"));
    }

    #[test]
    fn fixes_need_a_recorded_branch_and_an_existing_worktree() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let error = fix_task(&f.dir, &session(&f.dir, None)).unwrap_err();
        assert!(error.to_string().contains("predates recorded branches"));
        let gone = f.dir.join("gone");
        let error = fix_task(&f.dir, &session(&gone, Some("feature/a"))).unwrap_err();
        assert!(error.to_string().contains("no longer exists"));
        // A fix agent started in a subfolder maps back to its worktree's review.
        let sub = f.dir.join("app");
        fs::create_dir_all(&sub).unwrap();
        assert!(handoff(&f.dir, &session(&sub, Some("feature/a"))).is_ok());
    }

    #[test]
    fn fix_task_refuses_what_handoff_would_before_anything_changes() {
        let f = Fixture::new();
        let open = session(&f.dir, Some("feature/a"));
        f.prepare("claude").unwrap();
        let error = fix_task(&f.dir, &open).unwrap_err();
        assert!(error.to_string().contains("No review findings"));
        f.save("Finding", true);
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        let error = fix_task(&f.dir, &open).unwrap_err();
        assert!(error.to_string().contains("no longer checked out"));
    }

    #[test]
    fn fix_task_finds_the_task_else_the_project_folder() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let open = session(&f.dir, Some("feature/a"));
        // A project opened in a subfolder still reviews at the worktree's top.
        let sub = f.dir.join("app");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(fix_task(&sub, &open).unwrap(), None);
        let linked = reviewed_linked(&f);
        let other = session(&linked, Some("main"));
        let error = fix_task(&f.dir, &other).unwrap_err();
        assert!(error.to_string().contains("Add this worktree as a task"));
        let canonical = linked.canonicalize().unwrap();
        let task =
            crate::tasks::attach(&f.dir, &canonical.display().to_string(), None, vec![]).unwrap();
        assert_eq!(fix_task(&f.dir, &other).unwrap(), Some(task.id));
        // A task holding the open checkout wins over the bare project folder.
        let own = crate::tasks::attach(&f.dir, &f.dir.display().to_string(), None, vec![]).unwrap();
        assert_eq!(fix_task(&sub, &open).unwrap(), Some(own.id));
    }

    #[test]
    fn handoff_refuses_a_launch_outside_the_reviewed_worktree() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let linked = f.dir.join("linked");
        git::run(git::git(&f.dir).args([
            "worktree",
            "add",
            "-q",
            linked.to_str().unwrap(),
            "main",
        ]))
        .unwrap();
        let target = session(&f.dir, Some(&f.request.branch));
        let error = handoff(&linked, &target).unwrap_err();
        assert!(error.to_string().contains("isn't in the reviewed worktree"));
    }

    #[test]
    fn handoff_inlines_current_findings_without_granting_reviews() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("P2 file.txt:1: Fix this", true);
        let section = fix(&f.dir, &f.request.branch).unwrap();
        assert_eq!(section.title, "Review findings");
        for text in [
            "feature/a",
            "Base: main",
            "Reviewed: HEAD ",
            "may already address",
            "Fix this",
        ] {
            assert!(section.body.contains(text), "{text}");
        }
        let terminal = serde_json::from_value(serde_json::json!({
            "id": "fix", "name": "Fix", "kind": "agent", "command": "claude"
        }))
        .unwrap();
        let spec = context::task_root_session_spec(
            &f.project,
            &[],
            &terminal,
            None,
            &AllowAll,
            &[section],
            Some(context::Kickoff::FixFindings),
        )
        .unwrap();
        assert!(!spec.dirs.iter().any(|d| d.ends_with("reviews")));
        assert!(!spec.command.contains("/patchbay/reviews"));
    }

    #[test]
    fn handoff_stays_the_same_as_the_fix_commits_and_edits() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let before = fix_body(&f);
        let file = f.dir.join("file.txt");
        fs::write(&file, "edited\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(1))
            .unwrap();
        assert_eq!(fix_body(&f), before);
        git::run(git::git(&f.dir).args(["commit", "-qam", "after review"])).unwrap();
        assert_eq!(fix_body(&f), before);
    }

    #[test]
    fn a_former_fix_starts_plainly_once_it_cannot_fix() {
        use context::{Fix, Kickoff, root_handoff};
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let review = session(&f.dir, Some("feature/a"));
        let again = Fix::Again(Some(review.clone()));
        let (kickoff, sections) = root_handoff(&f.project, None, &[], None, Some(&again)).unwrap();
        assert!(matches!(kickoff, Some(Kickoff::FixFindings)));
        assert_eq!(sections[0].title, "Review findings");
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        crate::plans::write(&f.dir, None, "A plan").unwrap();
        for fix in [again, Fix::Again(None)] {
            let (kickoff, sections) = root_handoff(
                &f.project,
                None,
                &[],
                Some(Kickoff::FixFindings),
                Some(&fix),
            )
            .unwrap();
            assert!(kickoff.is_none());
            assert!(sections.is_empty(), "no findings and no plan");
        }
        assert!(root_handoff(&f.project, None, &[], None, Some(&Fix::Review(review))).is_err());
    }

    #[test]
    fn handoff_reports_an_earlier_attempt() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Old finding", false);
        assert!(fix_body(&f).contains("a newer review hasn't written findings yet"));
    }

    /// The note a fix briefing ends a cut report with.
    fn cut_note(path: &Path) -> String {
        format!(
            "\n\n[The findings are truncated; read the complete report from the beginning in {}; read it only, and ask the user if you can't.]",
            path.display()
        )
    }

    #[test]
    fn handoff_inlines_up_to_its_limit_and_names_the_file_when_cut() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        let prefix = "x".repeat(HANDOFF_LIMIT);
        f.save(&prefix, true);
        let body = fix_body(&f);
        assert!(body.contains(&prefix));
        assert!(!body.contains("read the complete report from the beginning"));

        let full = format!("{prefix}y");
        f.save(&full, true);
        let body = fix_body(&f);
        let path = file(&f.dir, &f.request.branch).unwrap();
        assert!(body.ends_with(&format!("{prefix}{}", cut_note(&path))));
        assert_eq!(fs::read_to_string(path).unwrap(), full);
    }

    #[test]
    fn handoff_cuts_at_a_character_boundary() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        let prefix = "x".repeat(HANDOFF_LIMIT - 1);
        f.save(&format!("{prefix}é"), true);
        let body = fix_body(&f);
        let path = file(&f.dir, &f.request.branch).unwrap();
        assert!(body.ends_with(&format!("{prefix}{}", cut_note(&path))));
        assert!(!body.contains('é'));
        assert!(!body.contains('\u{fffd}'));
    }

    #[test]
    fn cut_fix_briefings_reread_the_whole_report_and_keep_new_restart_context() {
        use context::{Fix, root_handoff};
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        let text = "x".repeat(HANDOFF_LIMIT + 1);
        f.save(&text, true);
        let path = file(&f.dir, &f.request.branch).unwrap();
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        // Pin a cut report's briefing byte for byte, its note included, since Codex
        // carries it inline and Restart compares it.
        let pinned = format!(
            "Branch: {}\nBase: {}\nReviewed: HEAD {}, as it was when the review started\nFindings file: {}\n\nCommits since that HEAD and uncommitted changes (`git status`) may already address some findings.\n\n{}\n\n[The findings are truncated; read the complete report from the beginning in {}; read it only, and ask the user if you can't.]",
            f.request.branch,
            started.base,
            &started.head[..7],
            path.display(),
            &text[..HANDOFF_LIMIT],
            path.display()
        );
        assert_eq!(fix_body(&f), pinned);
        let again = Fix::Again(Some(session(&f.dir, Some(&f.request.branch))));
        let (_, sections) = root_handoff(&f.project, None, &[], None, Some(&again)).unwrap();
        assert_eq!(sections[0].body, pinned);
    }

    #[test]
    fn shares_give_small_reports_their_size_and_split_the_rest_evenly() {
        assert_eq!(shares(&[], 100), Vec::<usize>::new());
        assert_eq!(shares(&[500, 500, 500], 1000), [333, 333, 333]);
        assert_eq!(shares(&[1000, 0, 100, 1000], 1000), [450, 0, 100, 450]);
        assert_eq!(shares(&[10, 20], 1000), [10, 20]);
        assert_eq!(shares(&[0, 0], 1000), [0, 0]);
        for lens in [
            &[3, 7, 999, 2][..],
            &[1, 1000, 1000],
            &[0, 5000],
            &[333, 334, 335],
        ] {
            assert!(shares(lens, 1000).iter().sum::<usize>() <= 1000);
        }
    }

    #[test]
    fn three_reviewers_keep_reports_that_fit_the_budget() {
        let f = Fixture::new();
        let reports = ["a", "b", "c"].map(|lane| prepare_lane(&f, lane, "r1"));
        for (i, (_, path)) in reports.iter().enumerate() {
            save_at(
                path,
                &format!("Finding {i}\n{}", "x".repeat(25 * 1024)),
                true,
            );
        }
        let body = fix_body(&f);
        for i in 0..reports.len() {
            assert!(body.contains(&format!("Finding {i}\n{}", "x".repeat(25 * 1024))));
        }
        assert!(!body.contains("read the complete report from the beginning"));
        cleanup(reports.map(|(job, _)| job));
    }

    #[test]
    fn empty_reviewers_leave_the_budget_for_written_findings() {
        for empty in [None, Some(""), Some(" \n\t")] {
            let f = Fixture::new();
            let (a, path) = prepare_lane(&f, "a", "r1");
            let (b, empty_path) = prepare_lane(&f, "b", "r1");
            let header = "Verdict: issues\n[high] Finding\n";
            // A whitespace-only report still holds its own few bytes.
            let held = empty.map_or(0, str::len);
            let text = format!(
                "{header}{}",
                "x".repeat(HANDOFF_LIMIT - held - header.len())
            );
            save_at(&path, &text, true);
            if let Some(empty) = empty {
                save_at(&empty_path, empty, true);
            }
            let body = fix_body(&f);
            assert!(body.contains(&text));
            assert!(!body.contains("read the complete report from the beginning"));
            let panel = read(&f.dir, &f.request.branch).unwrap();
            assert_eq!(panel.reviewers.len(), 2);
            assert!(panel.reviewers[0].verdict.is_some());
            assert!(panel.reviewers[1].verdict.is_none());
            assert!(panel.text.contains(&format!(
                "{header}{}",
                "x".repeat(crate::plans::PLAN_LIMIT - held - header.len())
            )));
            assert!(
                panel.verdict.is_none(),
                "the empty reviewer still blocks completion"
            );
            cleanup([a, b]);
        }
    }

    #[test]
    fn unequal_reviewers_give_a_small_report_its_size_and_the_rest_to_a_large_one() {
        let f = Fixture::new();
        let (missing, _) = prepare_lane(&f, "a", "r1");
        let (small, small_path) = prepare_lane(&f, "b", "r1");
        let (large, large_path) = prepare_lane(&f, "c", "r1");
        let short = format!("Small\n{}", "s".repeat(1024));
        save_at(&small_path, &short, true);
        save_at(&large_path, &"l".repeat(HANDOFF_LIMIT), true);
        let body = fix_body(&f);
        assert!(body.contains(&short));
        let share = HANDOFF_LIMIT - short.len();
        assert!(body.contains(&format!("{}{}", "l".repeat(share), cut_note(&large_path))));
        assert!(!body.contains(&"l".repeat(share + 1)));
        assert_eq!(
            body.matches("read the complete report from the beginning")
                .count(),
            1
        );
        cleanup([missing, small, large]);
    }

    #[test]
    fn reports_written_after_their_path_stamps_get_a_share_and_verdict() {
        for previous in [None, Some("")] {
            let f = Fixture::new();
            let (a, path) = prepare_lane(&f, "a", "r1");
            let (b, late_path) = prepare_lane(&f, "b", "r1");
            save_at(&path, &"a".repeat(HANDOFF_LIMIT + 1), true);
            if let Some(previous) = previous {
                save_at(&late_path, previous, true);
            }
            let started = |p: &Path| -> Started {
                serde_json::from_slice(&fs::read(p.with_extension("json")).unwrap()).unwrap()
            };
            let lanes = [&path, &late_path].map(|p| Saved::stamped(p.clone(), started(p), false));
            let text = "Verdict: issues\n[high] Late finding\n";
            save_at(&late_path, text, true);
            // Exercise the same open, allocation and read path as panel and handoff.
            let reports = read_reports(lanes.into(), HANDOFF_LIMIT);
            assert!(reports.iter().map(|s| s.text.len()).sum::<usize>() <= HANDOFF_LIMIT);
            assert_eq!(reports[1].text, text);
            assert!(reports[1].fresh());
            assert_eq!(reports[1].verdict.as_ref().unwrap().counts.high, 1);
            let body = findings_body(&reports, &f.request.branch, true).unwrap();
            assert!(body.contains(text.trim()));
            cleanup([a, b]);
        }
    }

    #[test]
    fn unreadable_reports_leave_the_budget_for_readable_findings() {
        let f = Fixture::new();
        let (a, path) = prepare_lane(&f, "a", "r1");
        let (b, unreadable) = prepare_lane(&f, "b", "r1");
        let text = "x".repeat(HANDOFF_LIMIT);
        save_at(&path, &text, true);
        // Directories can be statted (and opened on Unix), but cannot supply reports.
        fs::create_dir(&unreadable).unwrap();
        assert!(FindingsStamp::read(&unreadable).is_some());
        let body = fix_body(&f);
        assert!(body.ends_with(&text));
        assert!(!body.contains("read the complete report from the beginning"));
        fs::remove_dir(unreadable).unwrap();
        cleanup([a, b]);
    }

    #[test]
    fn complete_report_cache_survives_budget_changes_from_another_reviewer() {
        let f = Fixture::new();
        let (a, path) = prepare_lane(&f, "a", "r1");
        let (b, growing) = prepare_lane(&f, "b", "r1");
        let each = HANDOFF_LIMIT / 2;
        save_at(&path, &"a".repeat(each), true);
        save_at(&growing, &"b".repeat(each), true);
        // Cache a complete report read with the old, larger budget.
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        let mut saved = Saved::stamped(path.clone(), started, false);
        let handle = saved.open();
        let saved = saved.read(handle, HANDOFF_LIMIT);
        assert!(!saved.truncated);
        save_at(&growing, &"b".repeat(each + 1), true);
        let body = fix_body(&f);
        assert!(body.contains(&"a".repeat(each)));
        assert_eq!(
            REPORTS.lock().unwrap_or_else(PoisonError::into_inner)[&path].limit,
            HANDOFF_LIMIT,
            "the complete cache entry was reused rather than replaced at the new limit"
        );
        cleanup([a, b]);
    }

    #[test]
    fn truncated_report_cache_is_reread_when_its_share_changes() {
        let f = Fixture::new();
        let (a, path) = prepare_lane(&f, "a", "r1");
        let (b, growing) = prepare_lane(&f, "b", "r1");
        save_at(&path, &"a".repeat(HANDOFF_LIMIT + 1), true);
        let body = fix_body(&f);
        assert!(body.contains(&"a".repeat(HANDOFF_LIMIT)));
        save_at(&growing, &"b".repeat(HANDOFF_LIMIT), true);
        let body = fix_body(&f);
        assert!(!body.contains(&"a".repeat(HANDOFF_LIMIT / 2 + 1)));
        assert!(body.contains(&"a".repeat(HANDOFF_LIMIT / 2)));
        cleanup([a, b]);
    }

    #[test]
    fn a_failed_read_leaves_no_text_or_verdict() {
        let f = Fixture::new();
        let (a, path) = prepare_lane(&f, "a", "r1");
        save_at(&path, "Verdict: issues\n[high] Finding\n", true);
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        let saved = read_reports(
            vec![Saved::stamped(path.clone(), started, false)],
            HANDOFF_LIMIT,
        )
        .pop()
        .unwrap();
        assert!(saved.verdict.is_some() && !saved.text.is_empty());
        fs::remove_file(&path).unwrap();
        let saved = read_reports(vec![saved], HANDOFF_LIMIT).pop().unwrap();
        assert!(saved.text.is_empty() && !saved.truncated);
        assert!(saved.verdict.is_none() && saved.stamp.is_none());
        cleanup([a]);
    }

    #[test]
    fn multi_reviewer_cuts_point_to_each_complete_report() {
        let f = Fixture::new();
        let reports = ["a", "b", "c"].map(|lane| prepare_lane(&f, lane, "r1"));
        let each = HANDOFF_LIMIT / reports.len();
        for (i, (_, path)) in reports.iter().enumerate() {
            let text = char::from(b'a' + u8::try_from(i).unwrap()).to_string();
            save_at(path, &text.repeat(each + 1), true);
        }
        let body = fix_body(&f);
        assert_eq!(
            body.matches("read the complete report from the beginning")
                .count(),
            3
        );
        for (i, (_, path)) in reports.iter().enumerate() {
            let text = char::from(b'a' + u8::try_from(i).unwrap()).to_string();
            assert!(body.contains(&format!("{}{}", text.repeat(each), cut_note(path))));
            assert!(!body.contains(&text.repeat(each + 1)));
        }
        cleanup(reports.map(|(job, _)| job));
    }

    #[test]
    fn handoff_reads_findings_from_a_linked_worktree() {
        let f = Fixture::new();
        let worktree = reviewed_linked(&f);
        let body = fix(&worktree, "main").unwrap().body;
        assert!(body.contains("Branch: main"));
        assert!(body.contains("Linked finding"));
        assert!(body.contains("Reviewed: HEAD "));
    }

    #[test]
    fn briefing_covers_merge_base_and_dirty_whole_branch_without_mutations() {
        let f = Fixture::new();
        fs::write(f.dir.join("file.txt"), "edited\n").unwrap();
        fs::write(f.dir.join("untracked.txt"), "new\n").unwrap();
        let before = git::run(git::git(&f.dir).args(["status", "--porcelain"])).unwrap();
        let index = fs::read(f.dir.join(".git/index")).unwrap();
        for command in ["claude", "codex", "printf review"] {
            let job = f.prepare(command).unwrap();
            let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
            let merge_base =
                git::run(git::git(&f.dir).args(["merge-base", "main", "HEAD"])).unwrap();
            if command == "codex" {
                assert!(body.contains(&format!("against base commit {merge_base}")));
                assert!(!body.contains("and untracked files"));
                assert!(!body.contains("This findings file is the only file you may write"));
            } else {
                assert!(body.contains(&format!("git diff {merge_base}..HEAD")));
                assert!(body.contains("git diff HEAD"));
            }
            for rule in [
                "untracked files",
                "Do not edit",
                "stage, commit, stash, reset or check out",
                "file:line",
                "Verdict: clean or Verdict: issues",
                "[critical], [high], [medium] or [low]",
                "say so explicitly",
                "PATCHBAY_REVIEW_FILE",
            ] {
                assert!(body.contains(rule), "{rule}");
            }
            assert!(!job.spec.exclusive_cwd);
            assert_eq!(job.spec.env[context::COMPONENT_ENV], REVIEW_SCOPE);
            assert_eq!(
                job.spec.env[REVIEW_FILE_ENV],
                file(&f.dir, &f.request.branch)
                    .unwrap()
                    .display()
                    .to_string()
            );
            assert_eq!(job.spec.dirs, vec![dir(&f.dir).unwrap()]);
            assert_eq!(
                job.terminal.id,
                crate::workspace::session_id(&f.request.worktree, REVIEW_SCOPE, "review")
            );
            match command {
                "claude" => {
                    assert!(job.spec.command.contains(" --add-dir "));
                    assert!(
                        job.spec
                            .command
                            .contains(&format!("high {merge_base}...HEAD"))
                    );
                    assert!(!job.spec.rerun_on_resume);
                    assert!(
                        !job.spec
                            .resume_command
                            .as_ref()
                            .unwrap()
                            .contains("/code-review")
                    );
                    assert!(body.contains("After /code-review reports"));
                }
                "codex" => {
                    assert!(
                        job.spec
                            .command
                            .contains(" exec --sandbox read-only review --base ")
                    );
                    assert!(job.spec.command.contains(" -o "));
                    assert!(job.spec.command.contains("developer_instructions"));
                    assert!(job.spec.rerun_on_resume);
                    assert_eq!(job.spec.resume_command.as_ref(), Some(&job.spec.command));
                    assert!(
                        job.spec
                            .notice
                            .as_ref()
                            .unwrap()
                            .contains("untracked files")
                    );
                }
                _ => assert_eq!(job.spec.command, command),
            }
            let pending = context::owned_briefing(&job.spec).unwrap();
            let mut retained = job.spec;
            context::retain_owned_briefing(&mut retained).unwrap();
            let retained_file = context::owned_briefing(&retained).unwrap();
            assert!(
                retained_file
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("review-")
            );
            assert_ne!(pending, retained_file);
            assert_eq!(fs::read_to_string(&retained_file).unwrap(), body);
            context::remove_owned_briefing_file(&pending);
            context::remove_owned_briefing_file(&retained_file);
            assert!(!pending.exists() && !retained_file.exists());
        }
        assert_eq!(
            git::run(git::git(&f.dir).args(["status", "--porcelain"])).unwrap(),
            before
        );
        assert_eq!(fs::read(f.dir.join(".git/index")).unwrap(), index);
    }

    #[test]
    fn rejects_unknown_base_detached_changed_and_unregistered_worktrees() {
        let mut f = Fixture::new();
        for base in ["missing", "--help", "main; touch x"] {
            f.request.base = base.into();
            assert!(f.prepare("claude").is_err());
        }
        f.request.base = f.request.branch.clone();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("other than the reviewed branch")
        );
        f.request.base = "main".into();
        f.request.branch = "changed".into();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("branch changed")
        );
        f.request.branch = "feature/a".into();
        git::run(git::git(&f.dir).args(["checkout", "--detach", "-q"])).unwrap();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("detached HEAD")
        );
        f.request.worktree = f.dir.join("missing").to_string_lossy().into();
        assert!(f.prepare("claude").is_err());
    }

    #[test]
    fn reads_current_and_old_findings_and_caps_utf8() {
        let f = Fixture::new();
        assert!(read(&f.dir, &f.request.branch).is_none());
        let job = f.prepare("claude").unwrap();
        f.save("old findings", false);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_none()
        );
        f.save("new findings", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, "new findings");
        assert_eq!(findings.base, "main");
        assert_eq!(
            findings.reviewed_head.unwrap(),
            git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap()
        );
        f.save(
            &format!("{}é", "a".repeat(crate::plans::PLAN_LIMIT - 1)),
            true,
        );
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert!(findings.truncated);
        assert_eq!(findings.text.len(), crate::plans::PLAN_LIMIT - 1);
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn resume_never_grants_git_dirs_and_rejects_unregistered_or_foreign_cwd() {
        let f = Fixture::new();
        let mut job = f.prepare("claude").unwrap();
        let roots = resume_roots(&f.dir, &job.spec).unwrap();
        assert_eq!(roots, vec![f.dir.clone(), dir(&f.dir).unwrap()]);
        crate::files::resolve(&roots, &job.spec.cwd).unwrap();
        assert_eq!(job.spec.dirs, vec![roots[1].clone()]);
        job.spec.cwd = f.dir.join("unregistered");
        fs::create_dir(&job.spec.cwd).unwrap();
        assert!(
            resume_roots(&f.dir, &job.spec)
                .unwrap_err()
                .to_string()
                .contains("no longer registered")
        );
        job.spec.cwd = f.dir.clone();
        // Replacing the registered path's Git metadata must not grant another repository.
        let original_git = f.dir.join(".git");
        fs::rename(&original_git, f.dir.join("old-git")).unwrap();
        git::run(git::git(&f.dir).args(["init", "-q"])).unwrap();
        assert!(resume_roots(&f.dir.join("old-git"), &job.spec).is_err());
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn rollback_restores_the_previous_review_attempt() {
        let mut f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        f.prepared("claude").unwrap().rollback();
        assert!(!sidecar.exists());
        let first = f.prepare("claude").unwrap();
        f.save("findings", true);
        let before = fs::read(&sidecar).unwrap();
        git::run(git::git(&f.dir).args(["branch", "release"])).unwrap();
        f.request.base = "release".into();
        std::thread::sleep(Duration::from_millis(5));
        let refused = f.prepared("claude").unwrap();
        let briefing = context::owned_briefing(&refused.job.spec).unwrap();
        assert_ne!(fs::read(&sidecar).unwrap(), before);
        refused.rollback();
        assert_eq!(fs::read(&sidecar).unwrap(), before);
        assert!(!briefing.exists());
        let restored = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(restored.text, "findings");
        assert_eq!(restored.base, "main");
        assert!(restored.reviewed_head.is_some());
        context::remove_owned_briefing_file(&context::owned_briefing(&first.spec).unwrap());
    }

    #[test]
    fn rollback_keeps_a_newer_attempts_sidecar() {
        let f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        let refused = f.prepared("claude").unwrap();
        let running = f.prepared("claude").unwrap();
        let current = fs::read(&sidecar).unwrap();
        refused.rollback();
        assert_eq!(fs::read(&sidecar).unwrap(), current);
        context::remove_owned_briefing_file(&context::owned_briefing(&running.job.spec).unwrap());
    }

    #[test]
    fn rollback_invalidates_the_round_cache_even_with_identical_metadata() {
        let f = Fixture::new();
        let job = f.prepare("claude").unwrap();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        // The replaced attempt is recorded in the next one, so give the original a
        // record of the same size: the metadata then stays identical.
        let mut original: Started = serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
        original.previous = Some(Previous {
            native: original.native,
            round: format!("round:{}", "y".repeat(original.round.len())),
            base: original.base.clone(),
        });
        fs::write(&sidecar, serde_json::to_vec(&original).unwrap()).unwrap();
        let previous = fs::read(&sidecar).unwrap();
        let modified = fs::metadata(&sidecar).unwrap().modified().unwrap();
        let mut next: Started = serde_json::from_slice(&previous).unwrap();
        let old_round = next.round.clone();
        next.round = "x".repeat(old_round.len());
        let attempt = Attempt::record(sidecar.clone(), &next, None).unwrap();
        assert_eq!(
            previous.len(),
            usize::try_from(fs::metadata(&sidecar).unwrap().len()).unwrap()
        );
        fs::File::open(&sidecar)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            rounds(&f.dir, &f.request.branch).last().unwrap().1[0]
                .1
                .round,
            next.round
        );
        attempt.rollback();
        fs::File::open(&sidecar)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            rounds(&f.dir, &f.request.branch).last().unwrap().1[0]
                .1
                .round,
            old_round
        );
        cleanup([job]);
    }

    #[test]
    fn launch_rolls_back_only_a_certain_refusal() {
        let f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        let lost = f.prepared("claude").unwrap();
        let briefing = context::owned_briefing(&lost.job.spec).unwrap();
        let written = fs::read(&sidecar).unwrap();
        assert!(
            lost.launch(|_| Err::<(), _>(("lost".into(), true)))
                .is_err()
        );
        let lost_record: Started = serde_json::from_slice(&fs::read(&sidecar).unwrap()).unwrap();
        let original: Started = serde_json::from_slice(&written).unwrap();
        assert_eq!(lost_record.attempt, original.attempt);
        assert_eq!(lost_record.launch_error.as_deref(), Some("lost"));
        let failed = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(failed.reviewers[0].error.as_deref(), Some("lost"));
        assert!(failed.verdict.is_none());
        let written = fs::read(&sidecar).unwrap();
        context::remove_owned_briefing_file(&briefing);
        let refused = f.prepared("claude").unwrap();
        assert!(
            refused
                .launch(|_| Err::<(), _>(("refused".into(), false)))
                .is_err()
        );
        assert_eq!(fs::read(&sidecar).unwrap(), written);
    }

    #[test]
    fn edits_anywhere_in_the_worktree_after_the_start_make_findings_stale() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("findings", true);
        let started = read(&f.dir, &f.request.branch).unwrap().started_ms;
        assert!(!read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        // Outside any project subfolder, and before the review started: reviewed.
        fs::create_dir_all(f.dir.join("other")).unwrap();
        let edit = f.dir.join("other/edit.txt");
        fs::write(&edit, "x").unwrap();
        let at = |ms: u64| {
            fs::File::options()
                .write(true)
                .open(&edit)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(ms))
                .unwrap();
        };
        at(started - 10);
        assert!(!read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        at(started + 10);
        assert!(read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        fs::remove_file(&edit).unwrap();
        // A deletion counts its folder's mtime.
        fs::remove_file(f.dir.join("file.txt")).unwrap();
        assert!(read(&f.dir, &f.request.branch).unwrap().edited_since_start);
    }

    #[test]
    fn resuming_records_a_new_attempt_only_when_the_worktree_moved_on() {
        let f = Fixture::new();
        let mut job = f.prepare("claude").unwrap();
        let briefing = context::owned_briefing(&job.spec).unwrap();
        f.save("findings", true);
        // The adapter receives public session summaries, with no launch environment.
        job.spec.env.clear();
        assert!(
            resume_attempt(&f.dir, &job.spec, &f.request.branch, None)
                .unwrap()
                .is_none()
        );

        fs::write(f.dir.join("file.txt"), "next\n").unwrap();
        git::run(git::git(&f.dir).args(["commit", "-qam", "next"])).unwrap();
        let head = git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap();
        let attempt = resume_attempt(&f.dir, &job.spec, &f.request.branch, None)
            .unwrap()
            .unwrap();
        // Restart has no review kickoff. Keep the saved findings for Fix and Merge,
        // but never attribute them to the new HEAD until the agent rewrites them.
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(stale.text, "findings");
        assert!(stale.reviewed_head.is_none());
        assert!(stale.verdict.is_none());
        assert!(fix_body(&f).contains("findings"));
        assert!(
            merge_handoff(&f.dir, &f.request.branch, &head)
                .unwrap()
                .body
                .contains("findings")
        );
        attempt.rollback();
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_some()
        );
        let attempt = resume_attempt(&f.dir, &job.spec, &f.request.branch, None)
            .unwrap()
            .unwrap();
        drop(attempt);
        f.save("new findings", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.reviewed_head.as_deref(), Some(head.as_str()));
        assert_eq!(findings.base, "main");

        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        assert!(resume_attempt(&f.dir, &job.spec, &f.request.branch, None).is_err());
        context::remove_owned_briefing_file(&briefing);
    }

    #[test]
    fn codex_resume_measures_its_range_from_the_launch_base_commit() {
        let f = Fixture::new();
        let job = f.prepare("codex").unwrap();
        let launch_base = git::run(git::git(&f.dir).args(["rev-parse", "main"])).unwrap();
        // main advances and the branch merges it; the rerun still names the old commit.
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        fs::write(f.dir.join("main.txt"), "main\n").unwrap();
        git::run(git::git(&f.dir).args(["add", "."])).unwrap();
        git::run(git::git(&f.dir).args(["commit", "-qm", "main"])).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-q", "feature/a"])).unwrap();
        git::run(git::git(&f.dir).args(["merge", "-q", "--no-edit", "main"])).unwrap();
        drop(
            resume_attempt(&f.dir, &job.spec, &f.request.branch, None)
                .unwrap()
                .unwrap(),
        );
        let path = file(&f.dir, &f.request.branch).unwrap();
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        assert_eq!(started.merge_base, launch_base);
        assert_eq!(started.base_commit.as_deref(), Some(launch_base.as_str()));
        if let Some(briefing) = context::owned_briefing(&job.spec) {
            context::remove_owned_briefing_file(&briefing);
        }
    }

    #[test]
    fn prune_skips_failed_deletions_keeps_live_findings_and_retries_later() {
        let mut f = Fixture::new();
        let failed = f.prepare("claude").unwrap();
        let failed_file = file(&f.dir, &f.request.branch).unwrap();
        // A directory at the findings path makes deletion fail on every platform.
        fs::create_dir(&failed_file).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        git::run(git::git(&f.dir).args(["branch", "-D", "feature/a"])).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-qb", "feature/live"])).unwrap();
        f.request.branch = "feature/live".into();
        let live = f.prepare("claude").unwrap();
        f.save("live findings", true);

        prune(&f.dir).unwrap();
        assert!(failed_file.with_extension("json").exists());
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, "live findings");
        assert_eq!(findings.base, "main");
        assert!(findings.reviewed_head.is_some());

        fs::remove_dir(&failed_file).unwrap();
        prune(&f.dir).unwrap();
        assert!(!failed_file.with_extension("json").exists());
        assert_eq!(
            read(&f.dir, &f.request.branch).unwrap().text,
            "live findings"
        );
        for spec in [failed.spec, live.spec] {
            context::remove_owned_briefing_file(&context::owned_briefing(&spec).unwrap());
        }
    }

    #[test]
    fn failed_findings_deletion_keeps_the_sidecar_for_retry() {
        let f = Fixture::new();
        let job = f.prepare("claude").unwrap();
        let file = file(&f.dir, &f.request.branch).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(remove(&f.dir, &f.request.branch).is_err());
        assert!(file.with_extension("json").exists());
        fs::remove_dir(&file).unwrap();
        remove(&f.dir, &f.request.branch).unwrap();
        assert!(!file.with_extension("json").exists());
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn remove_and_prune_use_branch_identity_and_keep_existing_refs() {
        let f = Fixture::new();
        let job = f.prepare("claude").unwrap();
        f.save("findings", true);
        let path = file(&f.dir, &f.request.branch).unwrap();
        assert_ne!(path, file(&f.dir, "feature-a").unwrap());
        prune(&f.dir).unwrap();
        assert!(path.exists());
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        git::run(git::git(&f.dir).args(["branch", "-D", "feature/a"])).unwrap();
        prune(&f.dir).unwrap();
        assert!(!path.exists() && !path.with_extension("json").exists());
        remove(&f.dir, &f.request.branch).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-qb", "feature/a"])).unwrap();
        let next = f.prepare("claude").unwrap();
        f.save("new findings", true);
        remove(&f.dir, &f.request.branch).unwrap();
        assert!(read(&f.dir, &f.request.branch).is_none());
        assert!(!path.with_extension("json").exists());
        for spec in [job.spec, next.spec] {
            context::remove_owned_briefing_file(&context::owned_briefing(&spec).unwrap());
        }
    }

    /// Prepare reviewer `lane` of `round`, returning its findings path.
    fn prepare_lane(f: &Fixture, lane: &str, round: &str) -> (AgentJob, PathBuf) {
        let mut request = f.request.clone();
        request.lane = Some(lane.into());
        request.round = Some(round.into());
        let terminal = serde_json::from_value(
            serde_json::json!({"id":lane, "name":lane, "kind":"agent", "command":"claude"}),
        )
        .unwrap();
        let job = prepare(&f.project, &request, &terminal, &AllowAll, None)
            .unwrap()
            .job;
        (
            job,
            lane_file(&f.dir, &f.request.branch, Some(lane)).unwrap(),
        )
    }

    /// Write `text` to findings `path`, modified after its attempt started when `after`.
    fn save_at(path: &Path, text: &str, after: bool) {
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        fs::write(path, text).unwrap();
        let time = if after {
            started.started_ms + 10
        } else {
            started.started_ms.saturating_sub(10)
        };
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(time))
            .unwrap();
    }

    fn cleanup(jobs: impl IntoIterator<Item = AgentJob>) {
        for file in jobs
            .into_iter()
            .filter_map(|job| context::owned_briefing(&job.spec))
        {
            context::remove_owned_briefing_file(&file);
        }
    }

    #[test]
    fn lanes_get_their_own_slot_and_file_inside_the_reviews_folder() {
        let f = Fixture::new();
        let (claude, claude_file) = prepare_lane(&f, "claude", "r1");
        let (odd, odd_file) = prepare_lane(&f, "../../x y", "r1");
        let folder = dir(&f.dir).unwrap();
        for path in [&claude_file, &odd_file] {
            assert_eq!(path.parent(), Some(folder.as_path()));
            assert_ne!(*path, file(&f.dir, &f.request.branch).unwrap());
            assert!(path.with_extension("json").exists());
        }
        assert_ne!(claude.terminal.id, odd.terminal.id);
        assert_ne!(claude.terminal.id, f.prepare("claude").unwrap().terminal.id);
        assert_eq!(claude.terminal.name, "Review · feature/a · claude");
        assert_eq!(
            claude.spec.env.get(REVIEW_FILE_ENV).map(String::as_str),
            Some(claude_file.to_str().unwrap())
        );
        cleanup([claude, odd]);
    }

    #[test]
    fn a_round_combines_its_reviewers_once_all_have_written() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        let (b, b_file) = prepare_lane(&f, "codex", "r1");
        save_at(
            &a_file,
            "Verdict: issues\nCounts: {\"critical\":0,\"high\":1,\"medium\":0,\"low\":0}\n- [high] A",
            true,
        );
        let partial = read(&f.dir, &f.request.branch).unwrap();
        assert!(partial.reviewed_head.is_none());
        assert!(partial.verdict.is_none());
        assert_eq!(
            partial
                .reviewers
                .iter()
                .map(|r| (r.lane.as_deref(), r.finished))
                .collect::<Vec<_>>(),
            [(Some("claude"), true), (Some("codex"), false)]
        );
        save_at(
            &b_file,
            "Verdict: issues\nCounts: {\"critical\":0,\"high\":1,\"medium\":0,\"low\":2}\n- [high] A\n- [low] B\n- [low] C",
            true,
        );
        let all = read(&f.dir, &f.request.branch).unwrap();
        assert!(all.reviewed_head.is_some());
        let verdict = all.verdict.unwrap();
        assert!(!verdict.clean);
        assert_eq!((verdict.counts.high, verdict.counts.low), (1, 2));
        assert!(
            all.text.contains("## Reviewer: claude") && all.text.contains("## Reviewer: codex")
        );

        let body = fix_body(&f);
        assert!(body.contains("2 reviewers reviewed this branch independently"));
        assert!(body.contains("### Reviewer: claude") && body.contains("### Reviewer: codex"));
        assert!(fix_task(&f.dir, &session(&f.dir, Some("feature/a"))).is_ok());
        cleanup([a, b]);
    }

    #[test]
    fn a_later_round_replaces_every_reviewer_of_the_earlier_one() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        let (b, b_file) = prepare_lane(&f, "codex", "r1");
        save_at(&a_file, "Verdict: clean", true);
        save_at(&b_file, "Verdict: clean", true);
        std::thread::sleep(Duration::from_millis(5));
        // A single reviewer starts a new round of its own.
        let single = f.prepare("claude").unwrap();
        f.save("Verdict: issues\n- [low] Only", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, "Verdict: issues\n- [low] Only");
        assert_eq!(findings.reviewers.len(), 1);
        assert!(findings.reviewers[0].lane.is_none());
        std::thread::sleep(Duration::from_millis(5));
        let (c, c_file) = prepare_lane(&f, "codex", "r2");
        save_at(&c_file, "Verdict: clean", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.reviewers.len(), 1);
        assert_eq!(findings.reviewers[0].lane.as_deref(), Some("codex"));
        assert!(findings.verdict.unwrap().clean);
        cleanup([a, b, single, c]);
    }

    #[test]
    fn a_new_round_preserves_stale_findings_and_waits_for_every_reviewer() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        let (b, b_file) = prepare_lane(&f, "codex", "r1");
        save_at(&a_file, "Verdict: clean", true);
        save_at(&b_file, "Verdict: clean", true);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .verdict
                .unwrap()
                .clean
        );

        let (next_a, _) = prepare_lane(&f, "claude", "r2");
        let (next_b, _) = prepare_lane(&f, "codex", "r2");
        assert!(a_file.exists() && b_file.exists());
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert!(stale.verdict.is_none() && stale.reviewed_head.is_none());
        assert!(stale.reviewers.iter().all(|r| !r.finished));
        save_at(&a_file, "Verdict: clean", true);
        let partial = read(&f.dir, &f.request.branch).unwrap();
        assert!(partial.verdict.is_none() && partial.reviewed_head.is_none());
        // Even a stale file restored externally cannot supply the missing verdict.
        save_at(&b_file, "Verdict: clean", false);
        assert!(read(&f.dir, &f.request.branch).unwrap().verdict.is_none());
        save_at(&b_file, "Verdict: issues\n- [high] New finding", true);
        let all = read(&f.dir, &f.request.branch).unwrap();
        assert!(all.reviewed_head.is_some());
        assert_eq!(all.verdict.unwrap().counts.high, 1);
        cleanup([a, b, next_a, next_b]);
    }

    #[test]
    fn removing_and_resuming_cover_every_lane() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        let (b, b_file) = prepare_lane(&f, "codex", "r1");
        save_at(&a_file, "findings", true);
        // The adapter receives public session summaries, with no launch environment.
        let mut summary = a.spec.clone();
        summary.env.clear();
        assert!(
            resume_attempt(&f.dir, &summary, &f.request.branch, Some("claude"))
                .unwrap()
                .is_none()
        );
        fs::write(f.dir.join("file.txt"), "next\n").unwrap();
        git::run(git::git(&f.dir).args(["commit", "-qam", "next"])).unwrap();
        // The resumed lane starts its own round, leaving its old peers alone.
        let before = fs::read(b_file.with_extension("json")).unwrap();
        resume_attempt(&f.dir, &summary, &f.request.branch, Some("claude"))
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(b_file.with_extension("json")).unwrap(), before);
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(stale.text, "findings");
        assert!(stale.reviewed_head.is_none());
        save_at(&a_file, "Verdict: clean", true);
        let head = git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap();
        assert_eq!(
            read(&f.dir, &f.request.branch).unwrap().reviewed_head,
            Some(head)
        );
        // A lane that never wrote findings still has its sidecar removed.
        remove(&f.dir, &f.request.branch).unwrap();
        for path in [&a_file, &b_file] {
            assert!(!path.exists() && !path.with_extension("json").exists());
        }
        assert!(read(&f.dir, &f.request.branch).is_none());
        cleanup([a, b]);
    }

    #[test]
    fn resuming_an_unchanged_old_lane_keeps_the_latest_multi_reviewer_round() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "old", "r1");
        save_at(&a_file, "Verdict: issues\n- [high] Old finding", true);
        std::thread::sleep(Duration::from_millis(5));
        let (b, b_file) = prepare_lane(&f, "claude", "r2");
        let (c, c_file) = prepare_lane(&f, "codex", "r2");
        save_at(&b_file, "Verdict: clean", true);
        save_at(&c_file, "Verdict: issues\n- [low] Current finding", true);
        let before = fs::read(a_file.with_extension("json")).unwrap();
        assert_eq!(read(&f.dir, &f.request.branch).unwrap().reviewers.len(), 2);
        assert!(
            resume_attempt(&f.dir, &a.spec, &f.request.branch, Some("old"))
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(a_file.with_extension("json")).unwrap(), before);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.reviewers.len(), 2);
        assert_eq!(findings.verdict.unwrap().counts.low, 1);
        assert!(findings.reviewed_head.is_some());
        assert!(fix_body(&f).contains("Current finding"));
        assert!(!fix_body(&f).contains("Old finding"));
        cleanup([a, b, c]);
    }

    #[test]
    fn an_old_lane_resumed_after_tree_changes_starts_a_round_and_keeps_stale_findings() {
        let f = Fixture::new();
        let (old, path) = prepare_lane(&f, "old", "r1");
        save_at(&path, "Verdict: issues\n- [high] Saved finding", true);
        std::thread::sleep(Duration::from_millis(5));
        let newer = f.prepare("claude").unwrap();
        f.save("Verdict: clean", true);
        fs::write(f.dir.join("file.txt"), "new work\n").unwrap();
        git::run(git::git(&f.dir).args(["commit", "-qam", "new"])).unwrap();
        let attempt = resume_attempt(&f.dir, &old.spec, &f.request.branch, Some("old"))
            .unwrap()
            .unwrap();
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(stale.reviewers.len(), 1);
        // The newer single review's findings, not the lane's own older ones.
        assert_eq!(stale.text, "Verdict: clean");
        assert!(stale.reviewed_head.is_none() && stale.verdict.is_none());
        save_at(&path, "Verdict: clean", true);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_some()
        );
        attempt.rollback();
        assert_eq!(
            read(&f.dir, &f.request.branch).unwrap().reviewers[0].lane,
            None
        );
        cleanup([old, newer]);
    }

    #[test]
    fn a_new_lane_set_shows_the_latest_earlier_findings_until_it_writes() {
        for old_single_file in [true, false] {
            let f = Fixture::new();
            if old_single_file {
                // A single review long ago, whose file the next single review reuses.
                let old = f.prepare("claude").unwrap();
                f.save("Verdict: issues\n- [high] Weeks-old finding", true);
                cleanup([old]);
                std::thread::sleep(Duration::from_millis(5));
            }
            let (a, a_file) = prepare_lane(&f, "claude", "r1");
            let (b, b_file) = prepare_lane(&f, "codex", "r1");
            save_at(&a_file, "Verdict: issues\n- [high] Round one A", true);
            save_at(&b_file, "Verdict: issues\n- [low] Round one B", true);
            std::thread::sleep(Duration::from_millis(5));
            let single = f.prepare("claude").unwrap();
            let stale = read(&f.dir, &f.request.branch).unwrap();
            assert!(stale.text.contains("Round one A") && stale.text.contains("Round one B"));
            assert!(!stale.text.contains("Weeks-old"));
            assert!(stale.verdict.is_none() && stale.reviewed_head.is_none());
            assert_eq!(stale.reviewers.len(), 1);
            assert!(stale.reviewers[0].lane.is_none() && !stale.reviewers[0].finished);
            let body = fix_body(&f);
            assert!(body.contains("Round one A") && !body.contains("Weeks-old"));
            assert!(
                body.contains("an earlier attempt; a newer review hasn't written findings yet")
            );
            let head = git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap();
            let merge = merge_handoff(&f.dir, &f.request.branch, &head)
                .unwrap()
                .body;
            assert!(merge.contains("Round one B"));
            assert!(merge.contains("Reviewed HEAD matches source HEAD: false"));
            // Once the new reviewer writes, only its findings count.
            f.save("Verdict: clean", true);
            let current = read(&f.dir, &f.request.branch).unwrap();
            assert_eq!(current.text, "Verdict: clean");
            assert!(current.verdict.unwrap().clean && current.reviewed_head.is_some());
            cleanup([a, b, single]);
        }
    }

    #[test]
    fn shown_findings_keep_their_own_base_and_report_the_latest_round() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        save_at(&a_file, "Verdict: issues\n- [high] Against main", true);
        assert_eq!(read(&f.dir, &f.request.branch).unwrap().round, "r1");
        std::thread::sleep(Duration::from_millis(5));
        git::run(git::git(&f.dir).args(["branch", "other", "main"])).unwrap();
        let mut request = f.request.clone();
        request.base = "other".into();
        request.round = Some("r2".into());
        let terminal = serde_json::from_value(
            serde_json::json!({"id":"agent", "name":"Agent", "kind":"agent", "command":"claude"}),
        )
        .unwrap();
        let single = prepare(&f.project, &request, &terminal, &AllowAll, None)
            .unwrap()
            .job;
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert!(stale.text.contains("Against main"));
        assert_eq!((stale.base.as_str(), stale.round.as_str()), ("main", "r2"));
        f.save("Verdict: clean", true);
        let current = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(
            (current.base.as_str(), current.text.as_str()),
            ("other", "Verdict: clean")
        );
        cleanup([a, single]);
    }

    #[test]
    fn earlier_findings_include_a_lane_the_latest_round_reused() {
        let f = Fixture::new();
        let (a, a_file) = prepare_lane(&f, "claude", "r1");
        let (b, b_file) = prepare_lane(&f, "codex", "r1");
        save_at(&a_file, "Verdict: issues\n- [high] Round one claude", true);
        save_at(&b_file, "Verdict: issues\n- [low] Round one codex", true);
        std::thread::sleep(Duration::from_millis(5));
        // The next round reuses claude's lane, whose file still holds round one's findings.
        let (c, _) = prepare_lane(&f, "claude", "r2");
        let (d, _) = prepare_lane(&f, "gemini", "r2");
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert!(stale.text.contains("Round one claude"), "{}", stale.text);
        assert!(stale.text.contains("Round one codex"), "{}", stale.text);
        assert_eq!((stale.round.as_str(), stale.reviewers.len()), ("r2", 2));
        assert!(stale.verdict.is_none() && stale.reviewed_head.is_none());
        let body = fix_body(&f);
        assert!(body.contains("Round one claude") && body.contains("Round one codex"));
        assert!(body.contains("2 reviewers reviewed this branch independently"));
        cleanup([a, b, c, d]);
    }

    #[test]
    fn round_cache_evicts_the_least_recently_used_branch() {
        let mut cache = BTreeMap::new();
        for index in 0..ROUND_CACHE_LIMIT {
            cached_round(&mut cache, PathBuf::from(index.to_string()));
        }
        // Reading an existing entry refreshes it without evicting another branch.
        cached_round(&mut cache, PathBuf::from("0"));
        assert_eq!(cache.len(), ROUND_CACHE_LIMIT);
        cached_round(&mut cache, PathBuf::from("new branch"));
        assert_eq!(cache.len(), ROUND_CACHE_LIMIT);
        assert!(cache.contains_key(&PathBuf::from("0")));
        assert!(!cache.contains_key(&PathBuf::from("1")));
    }

    #[test]
    fn recording_an_attempt_preserves_large_findings_and_their_timestamp() {
        let f = Fixture::new();
        let first = f.prepare("claude").unwrap();
        let path = file(&f.dir, &f.request.branch).unwrap();
        let bytes = "Saved finding\n".repeat(HANDOFF_LIMIT);
        f.save(&bytes, true);
        let stamp = FindingsStamp::read(&path).unwrap();
        let next = f.prepared("claude").unwrap();
        assert_eq!(FindingsStamp::read(&path).unwrap(), stamp);
        let stale = read(&f.dir, &f.request.branch).unwrap();
        assert!(stale.truncated && stale.reviewed_head.is_none());
        next.rollback();
        assert_eq!(FindingsStamp::read(&path).unwrap(), stamp);
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_some()
        );
        cleanup([first]);
    }

    #[test]
    fn fresh_findings_resolve_an_uncertain_launch_error() {
        let f = Fixture::new();
        let prepared = f.prepared("claude").unwrap();
        let briefing = context::owned_briefing(&prepared.job.spec).unwrap();
        assert!(
            prepared
                .launch(|_| Err::<(), _>(("lost reply".into(), true)))
                .is_err()
        );
        assert!(
            read(&f.dir, &f.request.branch).unwrap().reviewers[0]
                .error
                .is_some()
        );
        f.save("Verdict: clean", true);
        let complete = read(&f.dir, &f.request.branch).unwrap();
        assert!(complete.verdict.unwrap().clean);
        assert!(complete.reviewed_head.is_some());
        assert!(complete.reviewers[0].error.is_none());
        context::remove_owned_briefing_file(&briefing);
    }

    #[test]
    fn combined_verdicts_need_every_reviewer_and_take_the_largest_counts() {
        let v = |text: &str| verdict(text);
        assert!(combined([v("Verdict: clean"), None]).is_none());
        let both = combined([
            v("Verdict: issues\n- [high] A\n- [low] B"),
            v("Verdict: issues\n- [high] A\n- [critical] C"),
        ])
        .unwrap();
        assert!(!both.clean);
        assert_eq!(
            both.counts,
            Severities {
                critical: 1,
                high: 1,
                low: 1,
                ..Severities::default()
            }
        );
        assert!(
            combined([v("Verdict: clean"), v("Verdict: clean")])
                .unwrap()
                .clean
        );
    }
}
