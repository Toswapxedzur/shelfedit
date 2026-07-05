//! Read/write access to the legacy SQLite project database.
//! Reuses the existing on-disk layout and DB (`~/.local_ai_video_editor/
//! shelfedit.db`). Editing writes a new timeline *version* (the schema is
//! versioned), so the frozen legacy app stays compatible.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use rusqlite::{Connection, OpenFlags};

use crate::model::TimelineData;

pub fn db_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".local_ai_video_editor").join("shelfedit.db")
}

#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub kind: String,
}

impl MediaInfo {
    pub fn exists(&self) -> bool {
        Path::new(&self.path).exists()
    }
}

#[derive(Debug, Clone)]
pub struct LoadedProject {
    pub project_id: String,
    pub name: String,
    pub timeline: TimelineData,
    pub media: HashMap<String, MediaInfo>,
}

impl LoadedProject {
    pub fn media_for(&self, media_id: &str) -> Option<&MediaInfo> {
        self.media.get(media_id)
    }
}

fn open_ro() -> Result<Connection> {
    let path = db_path();
    if !path.exists() {
        return Err(anyhow!("database not found at {}", path.display()));
    }
    Ok(Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?)
}

fn open_rw() -> Result<Connection> {
    let path = db_path();
    let conn = Connection::open(&path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    Ok(conn)
}

fn latest_timeline(conn: &Connection, project_id: &str) -> Result<Option<TimelineData>> {
    let mut stmt = conn.prepare(
        "SELECT data_json FROM timelines WHERE project_id = ?1 ORDER BY version DESC LIMIT 1",
    )?;
    let mut rows = stmt.query([project_id])?;
    if let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        Ok(serde_json::from_str::<TimelineData>(&json).ok())
    } else {
        Ok(None)
    }
}

fn media_for_ids(conn: &Connection, ids: &[String]) -> Result<HashMap<String, MediaInfo>> {
    let mut out = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT local_path, COALESCE(width,0), COALESCE(height,0), COALESCE(duration_seconds,0), \
         COALESCE(type,'video') FROM media_assets WHERE id = ?1 LIMIT 1",
    )?;
    for id in ids {
        let mut rows = stmt.query([id])?;
        if let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let w: i64 = row.get(1)?;
            let h: i64 = row.get(2)?;
            let dur: f64 = row.get(3)?;
            let kind: String = row.get(4)?;
            out.insert(
                id.clone(),
                MediaInfo {
                    id: id.clone(),
                    path,
                    width: w as u32,
                    height: h as u32,
                    duration: dur,
                    kind,
                },
            );
        }
    }
    Ok(out)
}

fn referenced_media_ids(td: &TimelineData) -> Vec<String> {
    let mut ids = vec![];
    for t in &td.tracks {
        for e in &t.elements {
            if let Some(m) = &e.media_id {
                if !ids.contains(m) {
                    ids.push(m.clone());
                }
            }
        }
    }
    ids
}

/// Pick the most recently updated project whose timeline references at least one
/// media file that exists on disk, and load it fully.
pub fn load_best() -> Result<LoadedProject> {
    let conn = open_ro()?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC")?;
    let projects: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    for (pid, name) in &projects {
        if let Some(td) = latest_timeline(&conn, pid)? {
            let ids = referenced_media_ids(&td);
            let media = media_for_ids(&conn, &ids)?;
            if media.values().any(|m| m.exists()) {
                return Ok(LoadedProject {
                    project_id: pid.clone(),
                    name: name.clone(),
                    timeline: td,
                    media,
                });
            }
        }
    }
    Err(anyhow!("no project with an existing referenced media file found"))
}

/// Save the timeline as a new version for the project.
pub fn save_timeline(project_id: &str, data: &TimelineData) -> Result<()> {
    if project_id.is_empty() {
        return Ok(()); // ad-hoc media, nothing to persist
    }
    let conn = open_rw()?;
    let json = serde_json::to_string(data)?;
    let next_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM timelines WHERE project_id = ?1",
            [project_id],
            |r| r.get(0),
        )
        .unwrap_or(1);
    let id = crate::ops::new_id("tl");
    conn.execute(
        "INSERT INTO timelines (id, project_id, version, data_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        rusqlite::params![id, project_id, next_version, json],
    )?;
    Ok(())
}

// ---- Slice-1 benchmark helper (kept for --selftest) ------------------------

#[derive(Debug, Clone)]
pub struct OpenableProject {
    pub project_id: String,
    pub project_name: String,
    pub media_id: String,
    pub media_path: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub fps: u32,
}

pub fn find_openable() -> Result<OpenableProject> {
    let lp = load_best()?;
    let fps = lp.timeline.canvas_or_default().fps.max(1);
    // First existing video media referenced by the timeline.
    let mid = lp
        .timeline
        .first_video_media_id()
        .and_then(|m| lp.media.get(&m).filter(|mi| mi.exists()).map(|_| m))
        .or_else(|| {
            lp.media
                .values()
                .find(|m| m.exists() && m.width > 0)
                .map(|m| m.id.clone())
        })
        .ok_or_else(|| anyhow!("no existing media"))?;
    let mi = lp.media.get(&mid).unwrap();
    Ok(OpenableProject {
        project_id: lp.project_id,
        project_name: lp.name,
        media_id: mid.clone(),
        media_path: mi.path.clone(),
        width: mi.width,
        height: mi.height,
        duration: if mi.duration > 0.0 {
            mi.duration
        } else {
            lp.timeline.duration
        },
        fps,
    })
}
