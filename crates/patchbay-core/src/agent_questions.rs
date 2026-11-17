//! Agent questions offered to Chat while the provider's question hook waits.
//!
//! A hook's `AskUser` call blocks on [`Questions::ask`]. Only sessions Chat shows
//! ([`Questions::watch`]) are offered; Chat must claim the question once its card is on
//! screen, or the provider's own menu asks instead. A claimed question waits for an
//! answer, a skip, or the deadline. Nothing here touches the agent's terminal.
use crate::agent_hooks::UserQuestion;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long an offered question waits for Chat to show and claim it.
pub const CLAIM_WAIT: Duration = Duration::from_secs(5);

/// Which agent asks, and what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub project_id: String,
    pub task: Option<String>,
    pub session_id: String,
    pub generation: Option<u64>,
    pub questions: Vec<UserQuestion>,
}

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
    /// When the provider's own menu takes over, in Unix milliseconds.
    pub deadline_ms: u64,
}

enum Outcome {
    Waiting { claimed: bool },
    Answered(Option<Vec<String>>),
}

#[derive(Default)]
pub struct Questions {
    pending: Mutex<Vec<(Pending, Outcome)>>,
    changed: Condvar,
    /// Sessions whose questions Chat shows; any other asks in its terminal at once.
    watched: Mutex<HashSet<String>>,
}

impl Questions {
    /// Offer a question, call `offered` so Chat can learn of it, and wait. Returns one
    /// answer per question, or `None` at once when Chat doesn't show the session, or when
    /// Chat doesn't claim it within `claim_wait`, the user skips it, or `wait` ends. An
    /// earlier unanswered question from the same session is skipped: the provider moved on.
    pub fn ask(
        &self,
        asked: Asked,
        claim_wait: Duration,
        wait: Duration,
        offered: impl FnOnce(&Pending),
    ) -> Option<Vec<String>> {
        if !self
            .watched
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&asked.session_id)
        {
            return None;
        }
        let start = Instant::now();
        let pending = Pending {
            id: crate::agent_bridge::new_id(),
            project_id: asked.project_id,
            task: asked.task,
            session_id: asked.session_id,
            generation: asked.generation,
            questions: asked.questions,
            deadline_ms: crate::pty::now_ms()
                .saturating_add(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX)),
        };
        let id = pending.id.clone();
        {
            let mut all = self.lock();
            for (earlier, outcome) in all.iter_mut() {
                // An answer already given stays with the hook about to take it.
                if earlier.session_id == pending.session_id
                    && matches!(outcome, Outcome::Waiting { .. })
                {
                    *outcome = Outcome::Answered(None);
                }
            }
            all.push((pending.clone(), Outcome::Waiting { claimed: false }));
        }
        self.changed.notify_all();
        offered(&pending);
        let mut all = self.lock();
        let answer = loop {
            let Some(index) = all.iter().position(|(p, _)| p.id == id) else {
                break None;
            };
            let limit = match &mut all[index].1 {
                Outcome::Answered(answer) => break answer.take(),
                Outcome::Waiting { claimed: true } => wait,
                Outcome::Waiting { claimed: false } => claim_wait.min(wait),
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

    /// The sessions Chat now shows. Questions of sessions it stopped showing go back to
    /// their terminals.
    pub fn watch(&self, sessions: impl IntoIterator<Item = String>) {
        let sessions: HashSet<String> = sessions.into_iter().collect();
        let mut all = self.lock();
        for (pending, outcome) in all.iter_mut() {
            if !sessions.contains(&pending.session_id) && matches!(outcome, Outcome::Waiting { .. })
            {
                *outcome = Outcome::Answered(None);
            }
        }
        *self.watched.lock().unwrap_or_else(PoisonError::into_inner) = sessions;
        drop(all);
        self.changed.notify_all();
    }

    /// Chat shows the question; it then waits for the full `wait`. False once it ended.
    pub fn claim(&self, id: &str) -> bool {
        let mut all = self.lock();
        let Some((_, outcome @ Outcome::Waiting { .. })) = all.iter_mut().find(|(p, _)| p.id == id)
        else {
            return false;
        };
        *outcome = Outcome::Waiting { claimed: true };
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
        if !matches!(outcome, Outcome::Waiting { .. })
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
            .filter(|(_, o)| matches!(o, Outcome::Waiting { .. }))
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

    fn asked(session: &str) -> Asked {
        Asked {
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
        let asked = asked(session);
        let handle = std::thread::spawn(move || {
            questions.ask(asked, claim_wait, wait, |p| {
                send.send(p.id.clone()).unwrap()
            })
        });
        (receive.recv().unwrap(), handle)
    }

    fn watching(sessions: &[&str]) -> Arc<Questions> {
        let questions = Arc::new(Questions::default());
        questions.watch(sessions.iter().map(|s| (*s).to_string()));
        questions
    }

    #[test]
    fn sessions_chat_doesnt_show_ask_in_their_terminal_at_once() {
        let questions = watching(&["shown"]);
        let start = Instant::now();
        let mut offered = false;
        let answer = questions.ask(
            asked("hidden"),
            Duration::from_secs(5),
            Duration::from_secs(5),
            |_| offered = true,
        );
        assert_eq!(answer, None);
        assert!(!offered);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn leaving_a_session_hands_its_question_back() {
        let questions = watching(&["s"]);
        let (id, handle) = asking(
            &questions,
            "s",
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert!(questions.claim(&id));
        questions.watch(Vec::new());
        assert_eq!(handle.join().unwrap(), None);
    }

    #[test]
    fn a_claimed_question_returns_the_chat_answer() {
        let questions = watching(&["s"]);
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
        let questions = watching(&["s"]);
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
        let questions = watching(&["s"]);
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
        let questions = watching(&["s"]);
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
