//! Editor state: the timeline document, selection, interaction mode, zoom,
//! undo/redo history, and debounced autosave back to SQLite. Port of the
//! responsibilities in `editor/useEditor.ts`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::commands::{apply_command, Command};
use crate::db::{self, LoadedProject, MediaInfo};
use crate::model::{Canvas, Element, TimelineData};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Select,
    Transform,
    Crop,
    Blade,
    Text,
}

const HISTORY_LIMIT: usize = 100;
const AUTOSAVE_DEBOUNCE: Duration = Duration::from_millis(800);

pub struct Editor {
    pub project_id: String,
    pub project_name: String,
    pub media: HashMap<String, MediaInfo>,
    pub canvas: Canvas,
    pub data: TimelineData,

    pub selected: Vec<String>,
    pub selected_track: Option<String>,
    pub mode: Mode,
    pub snapping: bool,
    pub px_per_sec: f32,
    pub playhead: f64,
    pub playing: bool,

    undo: Vec<TimelineData>,
    redo: Vec<TimelineData>,
    dirty: bool,
    last_edit: Instant,
}

impl Editor {
    pub fn from_loaded(lp: LoadedProject) -> Self {
        let canvas = lp.timeline.canvas_or_default();
        Editor {
            project_id: lp.project_id,
            project_name: lp.name,
            media: lp.media,
            canvas,
            data: lp.timeline,
            selected: vec![],
            selected_track: None,
            mode: Mode::Select,
            snapping: true,
            px_per_sec: 90.0,
            playhead: 0.0,
            playing: false,
            undo: vec![],
            redo: vec![],
            dirty: false,
            last_edit: Instant::now(),
        }
    }

    pub fn duration(&self) -> f64 {
        self.data.duration.max(0.0)
    }

    // ---- history / mutation -----------------------------------------------

    pub fn commit(&mut self, f: impl FnOnce(&mut TimelineData)) {
        let before = self.data.clone();
        f(&mut self.data);
        self.data.recompute_duration();
        self.undo.push(before);
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.mark_dirty();
    }

    pub fn run(&mut self, cmd: Command) {
        self.commit(|d| apply_command(d, &cmd));
    }

    /// Begin a continuous gesture (drag/scrub-edit): capture the document to
    /// restore on undo. Use with `preview_mut` + `end_interaction`.
    pub fn begin_interaction(&self) -> TimelineData {
        self.data.clone()
    }

    /// Live mutation during a gesture — no history entry.
    pub fn preview_mut(&mut self, f: impl FnOnce(&mut TimelineData)) {
        f(&mut self.data);
        self.data.recompute_duration();
    }

    /// Finish a gesture: push the pre-gesture snapshot as the single undo step.
    pub fn end_interaction(&mut self, before: TimelineData) {
        self.undo.push(before);
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.mark_dirty();
    }

    pub fn undo(&mut self) {
        if let Some(prev) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.data, prev));
            self.mark_dirty();
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.data, next));
            self.mark_dirty();
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
        self.last_edit = Instant::now();
    }

    /// Called every frame; writes a new timeline version once edits settle.
    pub fn maybe_autosave(&mut self) {
        if self.dirty && self.last_edit.elapsed() >= AUTOSAVE_DEBOUNCE {
            self.dirty = false;
            let pid = self.project_id.clone();
            let data = self.data.clone();
            std::thread::spawn(move || {
                if let Err(e) = db::save_timeline(&pid, &data) {
                    log::error!("autosave failed: {e}");
                }
            });
        }
    }

    pub fn save_now(&mut self) {
        if !self.project_id.is_empty() {
            let _ = db::save_timeline(&self.project_id, &self.data);
            self.dirty = false;
        }
    }

    // ---- selection ---------------------------------------------------------

    pub fn selected_id(&self) -> Option<&str> {
        self.selected.last().map(|s| s.as_str())
    }

    pub fn select_one(&mut self, id: Option<String>) {
        self.selected = id.into_iter().collect();
    }

    pub fn toggle_select(&mut self, id: &str) {
        if let Some(pos) = self.selected.iter().position(|x| x == id) {
            self.selected.remove(pos);
        } else {
            self.selected.push(id.to_string());
        }
    }

    pub fn is_selected(&self, id: &str) -> bool {
        self.selected.iter().any(|x| x == id)
    }

    /// Selected clips, primary (last-selected) first — the inspector reads [0].
    pub fn selected_clips(&self) -> Vec<Element> {
        self.selected
            .iter()
            .rev()
            .filter_map(|id| self.data.get(id).cloned())
            .collect()
    }

    /// Ids of clips linked to the current selection (for the yellow highlight).
    pub fn linked_highlight(&self) -> Vec<String> {
        let mut out = vec![];
        for id in &self.selected {
            for l in self.data.linked_ids(id) {
                if !out.contains(&l) {
                    out.push(l);
                }
            }
        }
        out
    }
}
