//! Agent questions offered to Chat while the provider's question hook waits.
//!
//! A hook's `AskUser` call blocks on [`Questions::ask`]. Chat must claim the question
//! promptly, or the provider's own menu asks instead; a claimed question waits for an
//! answer, a skip, or the deadline. Nothing here touches the agent's terminal.
use crate::agent_hooks::UserQuestion;
use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long an offered question waits for a Chat window to claim it.
pub const CLAIM_WAIT: Duration = Duration::from_secs(3);

/// A question offered to Chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub project_id: String,
    pub task: Option<String>,
    pub session_id: String,
    pub generation: Option<u64>,
    pub questions: Vec<UserQuestion>,
    /// When the wait ends, in Unix milliseconds.
    pub deadline_ms: u64,
    pub claimed: bool,
}

enum Outcome {
    Waiting,
    Answered(Option<Vec<String>>),
}

#[derive(Default)]
pub struct Questions {
    pending: Mutex<Vec<(Pending, Outcome)>>,
    changed: Condvar,
}

impl Questions {
    /// Offer `pending` (its `id` and `claimed` are set here), call `offered` so Chat can
    /// learn of it, and wait. Returns one answer per question, or `None` when no Chat claims
    /// it within `claim_wait`, the user skips it, or `wait` ends first. An earlier question
    /// from the same session is skipped: the provider has moved on from it.
    pub fn ask(
        &self,
        mut pending: Pending,
        claim_wait: Duration,
        wait: Duration,
        offered: impl FnOnce(&Pending),
    ) -> Option<Vec<String>> {
        let start = Instant::now();
        pending.id = crate::agent_bridge::new_id();
        pending.claimed = false;
        pending.deadline_ms = crate::pty::now_ms()
            .saturating_add(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX));
        let id = pending.id.clone();
        {
            let mut all = self.lock();
            for (earlier, outcome) in all.iter_mut() {
                if earlier.session_id == pending.session_id {
                    *outcome = Outcome::Answered(None);
                }
            }
            all.push((pending.clone(), Outcome::Waiting));
        }
        self.changed.notify_all();
        offered(&pending);
        let mut all = self.lock();
        let answer = loop {
            let Some(index) = all.iter().position(|(p, _)| p.id == id) else {
                break None;
            };
            if let Outcome::Answered(answer) = &mut all[index].1 {
                break answer.take();
            }
            let limit = if all[index].0.claimed {
                wait
            } else {
                claim_wait.min(wait)
            };
            let Some(left) = limit.checked_sub(start.elapsed()).filter(|d| !d.is_zero()) else {
                break None;
            };
            all = self
                .changed
                .wait_timeout(all, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        };
        all.retain(|(p, _)| p.id != id);
        answer
    }

    /// Chat will show the question; it then waits for the full `wait`. False once it ended.
    pub fn claim(&self, id: &str) -> bool {
        let mut all = self.lock();
        let Some((pending, Outcome::Waiting)) = all.iter_mut().find(|(p, _)| p.id == id) else {
            return false;
        };
        pending.claimed = true;
        drop(all);
        self.changed.notify_all();
        true
    }

    /// Answer a question, one nonblank answer per question, or `None` to leave it to the
    /// provider's own menu. False when it already ended or the answers don't fit.
    pub fn answer(&self, id: &str, answers: Option<Vec<String>>) -> bool {
        let mut all = self.lock();
        let Some((pending, outcome)) = all.iter_mut().find(|(p, _)| p.id == id) else {
            return false;
        };
        if !matches!(outcome, Outcome::Waiting)
            || answers.as_ref().is_some_and(|a| {
                a.len() != pending.questions.len() || a.iter().any(|a| a.trim().is_empty())
            })
        {
            return false;
        }
        *outcome = Outcome::Answered(answers);
        drop(all);
        self.changed.notify_all();
        true
    }

    /// Questions still waiting, for a window that opened after they were offered.
    #[must_use]
    pub fn list(&self) -> Vec<Pending> {
        self.lock()
            .iter()
            .filter(|(_, o)| matches!(o, Outcome::Waiting))
            .map(|(p, _)| p.clone())
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(Pending, Outcome)>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn pending(session: &str) -> Pending {
        Pending {
            id: String::new(),
            project_id: "p".into(),
            task: None,
            session_id: session.into(),
            generation: Some(1),
            questions: vec![UserQuestion {
                question: "Pick a color".into(),
                header: String::new(),
                multi_select: false,
                options: vec![],
            }],
            deadline_ms: 0,
            claimed: false,
        }
    }

    /// Run `ask` on a thread, handing the offered id back.
    fn asking(
        questions: &Arc<Questions>,
        session: &str,
        claim_wait: Duration,
        wait: Duration,
    ) -> (String, std::thread::JoinHandle<Option<Vec<String>>>) {
        let (send, receive) = std::sync::mpsc::channel();
        let questions = questions.clone();
        let pending = pending(session);
        let handle = std::thread::spawn(move || {
            questions.ask(pending, claim_wait, wait, |p| {
                send.send(p.id.clone()).unwrap()
            })
        });
        (receive.recv().unwrap(), handle)
    }

    #[test]
    fn a_claimed_question_returns_the_chat_answer() {
        let questions = Arc::new(Questions::default());
        let (id, handle) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert_eq!(questions.list().len(), 1);
        assert!(questions.claim(&id));
        assert!(
            !questions.answer(&id, Some(vec![" ".into()])),
            "blank answers are refused"
        );
        assert!(
            !questions.answer(&id, Some(vec!["Red".into(), "Blue".into()])),
            "one answer per question"
        );
        assert!(questions.answer(&id, Some(vec!["Red".into()])));
        assert_eq!(handle.join().unwrap(), Some(vec!["Red".into()]));
        assert!(questions.list().is_empty());
        assert!(!questions.answer(&id, Some(vec!["Blue".into()])));
    }

    #[test]
    fn an_unclaimed_question_falls_back_to_the_terminal() {
        let questions = Arc::new(Questions::default());
        let (id, handle) = asking(
            &questions,
            "s",
            Duration::from_millis(50),
            Duration::from_secs(30),
        );
        assert_eq!(handle.join().unwrap(), None);
        assert!(!questions.claim(&id));
    }

    #[test]
    fn a_skip_or_the_deadline_falls_back_to_the_terminal() {
        let questions = Arc::new(Questions::default());
        let (id, handle) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert!(questions.claim(&id));
        assert!(questions.answer(&id, None));
        assert_eq!(handle.join().unwrap(), None);

        let (id, handle) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_millis(80),
        );
        assert!(questions.claim(&id));
        assert_eq!(handle.join().unwrap(), None);
    }

    #[test]
    fn a_new_question_from_the_session_replaces_the_earlier_one() {
        let questions = Arc::new(Questions::default());
        let (first, earlier) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert!(questions.claim(&first));
        let (second, later) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert_eq!(earlier.join().unwrap(), None);
        assert!(questions.claim(&second));
        assert!(questions.answer(&second, Some(vec!["Blue".into()])));
        assert_eq!(later.join().unwrap(), Some(vec!["Blue".into()]));
    }
}
