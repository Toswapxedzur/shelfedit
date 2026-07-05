//! Timeline export. Builds an FFmpeg `filter_complex` from the timeline and
//! encodes to H.264/AAC. This is the authoritative render: the preview
//! approximates on the GPU, the export composites offline for exact output.
//!
//! Covered: per-clip trim + placement, transform (scale/position), crop, flip,
//! colour grade, green-screen (chroma), opacity + fades, text overlays, and an
//! audio mix honouring per-clip volume + fades across tracks.
//! Not yet: rotation and reveal-mask (documented; the GPU preview still shows
//! them). Runs in a background thread with progress parsed from FFmpeg.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::db::MediaInfo;
use crate::model::TimelineData;

#[derive(Clone, Debug)]
pub enum ExportState {
    Running(f32),
    Done(PathBuf),
    Failed(String),
}

pub struct ExportHandle {
    pub state: Arc<Mutex<ExportState>>,
}

fn has_audio(path: &str) -> bool {
    Command::new("ffprobe")
        .args([
            "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
            "-of", "csv=p=0", path,
        ])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

fn even(v: f64) -> i64 {
    let n = v.round() as i64;
    let n = if n % 2 != 0 { n + 1 } else { n };
    n.max(2)
}

fn hex_no_hash(s: &str) -> String {
    let h = s.trim_start_matches('#');
    if h.len() == 3 {
        h.chars().flat_map(|c| [c, c]).collect()
    } else {
        h.to_string()
    }
}

fn sanitize_text(s: &str) -> String {
    // Keep drawtext happy: strip the characters that need escaping.
    s.chars()
        .map(|c| match c {
            ':' | '\'' | '\\' | '%' | '{' | '}' => ' ',
            _ => c,
        })
        .collect()
}

struct Built {
    inputs: Vec<String>,
    filter: String,
    vmap: String,
    amap: Option<String>,
}

fn build_graph(
    data: &TimelineData,
    media: &HashMap<String, MediaInfo>,
    duration: f64,
) -> Result<Built, String> {
    let canvas = data.canvas_or_default();
    let (w, h) = (canvas.width.max(2), canvas.height.max(2));
    let fps = canvas.fps.max(1);

    let mut inputs: Vec<String> = Vec::new();
    let mut audio_probe: HashMap<String, bool> = HashMap::new();

    // Collect video clips bottom track first (so the top track overlays last).
    struct VClip<'a> {
        el: &'a crate::model::Element,
        input: usize,
        mi: MediaInfo,
    }
    let mut vclips: Vec<VClip> = Vec::new();
    for track in data.tracks.iter().rev() {
        if track.kind != "video" || track.is_hidden() {
            continue;
        }
        for el in &track.elements {
            let Some(mid) = el.media_id.as_deref() else { continue };
            let Some(mi) = media.get(mid) else { continue };
            if !std::path::Path::new(&mi.path).exists() {
                continue;
            }
            let input = inputs.len();
            inputs.push(mi.path.clone());
            vclips.push(VClip { el, input, mi: mi.clone() });
        }
    }

    // Audio clips: audio tracks + the audio of video clips that have a stream.
    struct AClip {
        input: usize,
        src_start: f64,
        dur: f64,
        ts: f64,
        volume: f64,
        afi: f64,
        afo: f64,
    }
    let mut aclips: Vec<AClip> = Vec::new();
    // video clips' audio (reuse their input index)
    for vc in &vclips {
        let has = *audio_probe
            .entry(vc.mi.path.clone())
            .or_insert_with(|| has_audio(&vc.mi.path));
        if has {
            aclips.push(AClip {
                input: vc.input,
                src_start: vc.el.source_start.unwrap_or(0.0),
                dur: vc.el.duration(),
                ts: vc.el.timeline_start,
                volume: vc.el.volume.unwrap_or(1.0),
                afi: vc.el.audio_fade_in.unwrap_or(0.0),
                afo: vc.el.audio_fade_out.unwrap_or(0.0),
            });
        }
    }
    for track in &data.tracks {
        if track.kind != "audio" || track.is_hidden() {
            continue;
        }
        for el in &track.elements {
            let Some(mid) = el.media_id.as_deref() else { continue };
            let Some(mi) = media.get(mid) else { continue };
            if !std::path::Path::new(&mi.path).exists() {
                continue;
            }
            let has = *audio_probe
                .entry(mi.path.clone())
                .or_insert_with(|| has_audio(&mi.path));
            if !has {
                continue;
            }
            let input = inputs.len();
            inputs.push(mi.path.clone());
            aclips.push(AClip {
                input,
                src_start: el.source_start.unwrap_or(0.0),
                dur: el.duration(),
                ts: el.timeline_start,
                volume: el.volume.unwrap_or(1.0),
                afi: el.audio_fade_in.unwrap_or(0.0),
                afo: el.audio_fade_out.unwrap_or(0.0),
            });
        }
    }

    let mut seg: Vec<String> = Vec::new();
    seg.push(format!("color=c=black:s={w}x{h}:r={fps}:d={duration:.3}[bg]"));

    let mut last = "[bg]".to_string();
    for (n, vc) in vclips.iter().enumerate() {
        let el = vc.el;
        let i = vc.input;
        let dur = el.duration();
        let ts = el.timeline_start;
        let te = el.end().min(duration);
        if ts >= duration {
            continue;
        }
        let ss = el.source_start.unwrap_or(0.0);
        let tf = el.transform_or_default();
        let (fw, fh) = (vc.mi.width.max(2) as f64, vc.mi.height.max(2) as f64);
        let fit = (w as f64 / fw).min(h as f64 / fh);
        let tw = even(fw * fit * tf.scale);
        let th = even(fh * fit * tf.scale);

        let mut chain = format!("[{i}:v]trim=start={ss:.3}:duration={dur:.3},setpts=PTS-STARTPTS");
        if let Some(c) = el.crop {
            chain += &format!(
                ",crop=iw*{cw:.4}:ih*{ch:.4}:iw*{cx:.4}:ih*{cy:.4}",
                cw = c.w.max(0.01),
                ch = c.h.max(0.01),
                cx = c.x.clamp(0.0, 0.99),
                cy = c.y.clamp(0.0, 0.99)
            );
        }
        chain += &format!(",scale={tw}:{th}");
        if el.flip_h.unwrap_or(false) {
            chain += ",hflip";
        }
        if el.flip_v.unwrap_or(false) {
            chain += ",vflip";
        }
        if let Some(col) = el.color {
            chain += &format!(
                ",eq=brightness={:.3}:contrast={:.3}:saturation={:.3}",
                col.brightness - 1.0,
                col.contrast,
                col.saturation
            );
        }
        if let Some(ch) = &el.chroma {
            if ch.enabled {
                chain += &format!(
                    ",chromakey=0x{}:{:.3}:{:.3}",
                    hex_no_hash(&ch.color),
                    ch.similarity,
                    ch.smoothness
                );
            }
        }
        chain += ",format=rgba";
        let fi = el.fade_in.unwrap_or(0.0);
        let fo = el.fade_out.unwrap_or(0.0);
        if fi > 0.0 {
            chain += &format!(",fade=t=in:st=0:d={fi:.3}:alpha=1");
        }
        if fo > 0.0 {
            chain += &format!(",fade=t=out:st={:.3}:d={fo:.3}:alpha=1", (dur - fo).max(0.0));
        }
        let op = el.opacity.unwrap_or(1.0);
        if op < 0.999 {
            chain += &format!(",colorchannelmixer=aa={op:.3}");
        }
        chain += &format!(",setpts=PTS+{ts:.3}/TB");
        let vlbl = format!("[v{n}]");
        seg.push(format!("{chain}{vlbl}"));

        let x = (w as f64 - tw as f64) / 2.0 + tf.x * w as f64;
        let y = (h as f64 - th as f64) / 2.0 + tf.y * h as f64;
        let out = format!("[o{n}]");
        seg.push(format!(
            "{last}{vlbl}overlay=x={x:.0}:y={y:.0}:eof_action=pass:enable='between(t\\,{ts:.3}\\,{te:.3})'{out}"
        ));
        last = out;
    }

    // Text overlays via drawtext on the composited video.
    let mut text_n = 0;
    for track in data.tracks.iter().rev() {
        if track.kind != "text" || track.is_hidden() {
            continue;
        }
        for el in &track.elements {
            let Some(txt) = el.text.as_deref() else { continue };
            let ts = el.timeline_start;
            let te = el.end().min(duration);
            if ts >= duration {
                continue;
            }
            let tf = el.transform_or_default();
            let fontsize = (h as f64 * 0.06 * tf.scale).max(10.0);
            let cx = 0.5 + tf.x;
            let cy = 0.5 + tf.y;
            let out = format!("[t{text_n}]");
            seg.push(format!(
                "{last}drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='{txt}':fontsize={fs:.0}:fontcolor=white:x=(w*{cx:.4}-text_w/2):y=(h*{cy:.4}-text_h/2):enable='between(t\\,{ts:.3}\\,{te:.3})'{out}",
                txt = sanitize_text(txt),
                fs = fontsize,
            ));
            last = out;
            text_n += 1;
        }
    }

    // Rename final video label.
    let vmap = "[vout]".to_string();
    // The `last` label is the final composited/text output; alias it to [vout].
    seg.push(format!("{last}null{vmap}"));

    // Audio mix.
    let mut amap = None;
    if !aclips.is_empty() {
        let mut albls = Vec::new();
        for (n, ac) in aclips.iter().enumerate() {
            let mut ch = format!(
                "[{i}:a]atrim=start={ss:.3}:duration={dur:.3},asetpts=PTS-STARTPTS,volume={vol:.3}",
                i = ac.input,
                ss = ac.src_start,
                dur = ac.dur,
                vol = ac.volume
            );
            if ac.afi > 0.0 {
                ch += &format!(",afade=t=in:st=0:d={:.3}", ac.afi);
            }
            if ac.afo > 0.0 {
                ch += &format!(",afade=t=out:st={:.3}:d={:.3}", (ac.dur - ac.afo).max(0.0), ac.afo);
            }
            let ms = (ac.ts * 1000.0).max(0.0) as i64;
            ch += &format!(",adelay={ms}|{ms}");
            let lbl = format!("[a{n}]");
            seg.push(format!("{ch}{lbl}"));
            albls.push(lbl);
        }
        seg.push(format!(
            "{}amix=inputs={}:normalize=0:dropout_transition=0[aout]",
            albls.join(""),
            albls.len()
        ));
        amap = Some("[aout]".to_string());
    }

    Ok(Built {
        inputs,
        filter: seg.join(";"),
        vmap,
        amap,
    })
}

pub fn start_export(
    data: TimelineData,
    media: HashMap<String, MediaInfo>,
    out_path: PathBuf,
    max_duration: Option<f64>,
) -> ExportHandle {
    let state = Arc::new(Mutex::new(ExportState::Running(0.0)));
    let st = state.clone();
    std::thread::spawn(move || {
        let mut duration = {
            let d = data.duration;
            if d > 0.05 { d } else { data.compute_duration() }
        }
        .max(0.1);
        if let Some(m) = max_duration {
            duration = duration.min(m);
        }
        let built = match build_graph(&data, &media, duration) {
            Ok(b) => b,
            Err(e) => {
                *st.lock().unwrap() = ExportState::Failed(e);
                return;
            }
        };

        let fps = data.canvas_or_default().fps.max(1);
        let mut cmd = Command::new("ffmpeg");
        cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("error").arg("-stats");
        for inp in &built.inputs {
            cmd.arg("-i").arg(inp);
        }
        cmd.arg("-filter_complex").arg(&built.filter);
        cmd.arg("-map").arg(&built.vmap);
        if let Some(a) = &built.amap {
            cmd.arg("-map").arg(a);
        }
        cmd.arg("-t").arg(format!("{duration:.3}"));
        cmd.arg("-r").arg(format!("{fps}"));
        cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]);
        if built.amap.is_some() {
            cmd.args(["-c:a", "aac", "-b:a", "192k"]);
        }
        cmd.arg(&out_path);
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());

        log::info!("export: ffmpeg -filter_complex <{} chars>", built.filter.len());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                *st.lock().unwrap() = ExportState::Failed(format!("spawn ffmpeg: {e}"));
                return;
            }
        };

        if let Some(err) = child.stderr.take() {
            // ffmpeg -stats separates progress lines with '\r'; split on both.
            let mut r = BufReader::new(err);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                match r.read_until(b'\r', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf).replace('\n', " ");
                        buf.clear();
                        if let Some(t) = parse_time(&line) {
                            let frac = (t / duration).clamp(0.0, 0.999) as f32;
                            *st.lock().unwrap() = ExportState::Running(frac);
                        } else if line.to_lowercase().contains("error") || line.contains("Invalid") {
                            log::error!("export ffmpeg: {}", line.trim());
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        match child.wait() {
            Ok(s) if s.success() => {
                *st.lock().unwrap() = ExportState::Done(out_path);
            }
            Ok(s) => {
                *st.lock().unwrap() =
                    ExportState::Failed(format!("ffmpeg exited with {s}"));
            }
            Err(e) => {
                *st.lock().unwrap() = ExportState::Failed(format!("wait: {e}"));
            }
        }
    });

    ExportHandle { state }
}

fn parse_time(line: &str) -> Option<f64> {
    // find "time=HH:MM:SS.xx"
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let ts: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() == 3 {
        let hh: f64 = parts[0].parse().ok()?;
        let mm: f64 = parts[1].parse().ok()?;
        let ss: f64 = parts[2].parse().ok()?;
        Some(hh * 3600.0 + mm * 60.0 + ss)
    } else {
        None
    }
}
