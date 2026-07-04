//! Read-only access to the legacy SQLite project database.
//!
//! We reuse the existing on-disk layout and DB (`~/.local_ai_video_editor/
//! shelfedit.db`). Slice 1 only needs to find a project whose first video
//! clip's source file exists on disk, so we can decode/play it.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use rusqlite::{Connection, OpenFlags};

use crate::model::TimelineData;

pub fn db_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".local_ai_video_editor").join("shelfedit.db")
}

/// A project we can open and play in Slice 1.
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

fn open_ro() -> Result<Connection> {
    let path = db_path();
    if !path.exists() {
        return Err(anyhow!("database not found at {}", path.display()));
    }
    // Read-only; the legacy app owns writes. SQLITE_OPEN_READ_ONLY still reads
    // committed WAL content.
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )?;
    Ok(conn)
}

/// Latest timeline JSON for a project, if any.
fn latest_timeline(conn: &Connection, project_id: &str) -> Result<Option<TimelineData>> {
    let mut stmt = conn.prepare(
        "SELECT data_json FROM timelines WHERE project_id = ?1 ORDER BY version DESC LIMIT 1",
    )?;
    let mut rows = stmt.query([project_id])?;
    if let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        match serde_json::from_str::<TimelineData>(&json) {
            Ok(td) => Ok(Some(td)),
            Err(_) => Ok(None),
        }
    } else {
        Ok(None)
    }
}

fn media_row(conn: &Connection, media_id: &str) -> Result<Option<(String, u32, u32, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT local_path, COALESCE(width,0), COALESCE(height,0), COALESCE(duration_seconds,0) \
         FROM media_assets WHERE id = ?1 LIMIT 1",
    )?;
    let mut rows = stmt.query([media_id])?;
    if let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        let w: i64 = row.get(1)?;
        let h: i64 = row.get(2)?;
        let dur: f64 = row.get(3)?;
        Ok(Some((path, w as u32, h as u32, dur)))
    } else {
        Ok(None)
    }
}

/// Find the most recently updated project whose first video clip's file exists.
pub fn find_openable() -> Result<OpenableProject> {
    let conn = open_ro()?;

    let mut stmt = conn.prepare(
        "SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC",
    )?;
    let project_rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    for (pid, name) in &project_rows {
        if let Some(td) = latest_timeline(&conn, pid)? {
            let fps = td.canvas.as_ref().map(|c| c.fps).unwrap_or(30).max(1);
            if let Some(media_id) = td.first_video_media_id() {
                if let Some((path, w, h, dur)) = media_row(&conn, &media_id)? {
                    if Path::new(&path).exists() && w > 0 && h > 0 {
                        return Ok(OpenableProject {
                            project_id: pid.clone(),
                            project_name: name.clone(),
                            media_id,
                            media_path: path,
                            width: w,
                            height: h,
                            duration: if dur > 0.0 { dur } else { td.duration },
                            fps,
                        });
                    }
                }
            }
        }
    }

    // Fallback: any media asset whose file exists.
    let mut stmt = conn.prepare(
        "SELECT id, local_path, COALESCE(width,0), COALESCE(height,0), COALESCE(duration_seconds,0) \
         FROM media_assets WHERE type = 'video'",
    )?;
    let rows: Vec<(String, String, i64, i64, f64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();
    for (mid, path, w, h, dur) in rows {
        if Path::new(&path).exists() && w > 0 && h > 0 {
            return Ok(OpenableProject {
                project_id: String::new(),
                project_name: "media".to_string(),
                media_id: mid,
                media_path: path,
                width: w as u32,
                height: h as u32,
                duration: dur,
                fps: 30,
            });
        }
    }

    Err(anyhow!("no project with an existing video file was found"))
}
