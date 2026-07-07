"use strict";

const LEFT_COL = 144;
const MIN_VIEW_SECONDS = 20;
const DEFAULT_TEXT_DUR = 3;
const MIN_CLIP = 0.1;
const NEUTRAL_COLOR = { brightness: 1, contrast: 1, saturation: 1 };
const NEUTRAL_TRANSFORM = { scale: 1, x: 0, y: 0, rotation: 0 };
const DEFAULT_CHROMA = {
    enabled: true,
    color: "#00ff00",
    similarity: 0.4,
    smoothness: 0.12,
};

const LOG = true;
const t0 = Date.now();
let logBridge = null;
const r3 = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
function log(tag, data) {
    if (!LOG) return;
    const ms = String(Date.now() - t0).padStart(6, " ");
    const line = `[JS ${ms}] ${tag} ${data ? JSON.stringify(data) : ""}`;
    if (logBridge && logBridge.log) logBridge.log(line);
    else console.log(line);
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatTime(seconds) {
    if (!seconds || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const cs = Math.floor((seconds - total) * 100);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function niceInterval(targetSeconds) {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) if (s >= targetSeconds) return s;
    return 600;
}

function clone(data) {
    return JSON.parse(JSON.stringify(data));
}

function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function clipDuration(el) {
    if (el.type === "text") {
        const end = el.timeline_end != null ? el.timeline_end : el.timeline_start + DEFAULT_TEXT_DUR;
        return Math.max(MIN_CLIP, end - el.timeline_start);
    }
    return Math.max(MIN_CLIP, (el.source_end || 0) - (el.source_start || 0));
}

function clipEnd(el) {
    return el.timeline_start + clipDuration(el);
}

function computeDuration(data) {
    let max = 0;
    for (const t of data.tracks || []) {
        for (const el of t.elements || []) max = Math.max(max, clipEnd(el));
    }
    return max;
}

function withDuration(data) {
    data.duration = computeDuration(data);
    data.tracks.forEach((t, i) => { t.order = i; });
    return data;
}

function findClip(data, clipId) {
    for (const track of data.tracks || []) {
        const el = (track.elements || []).find((e) => e.id === clipId);
        if (el) return { track, el };
    }
    return null;
}

function kindCompatible(elType, trackKind) {
    return elType === trackKind;
}

function linkedIds(data, clipId) {
    const found = findClip(data, clipId);
    if (!found || !found.el.groupId) return found ? [clipId] : [];
    const ids = [];
    for (const t of data.tracks) {
        for (const e of t.elements) if (e.groupId === found.el.groupId) ids.push(e.id);
    }
    return ids;
}

function rangeOverlaps(track, start, end, excludeIds) {
    for (const el of track.elements || []) {
        if (excludeIds.has(el.id)) continue;
        if (start < clipEnd(el) - 1e-6 && end > el.timeline_start + 1e-6) return true;
    }
    return false;
}

function moveClipGroup(data, clipId, newStart, targetTrackId) {
    const next = clone(data);
    const found = findClip(next, clipId);
    if (!found) return data;

    const gid = found.el.groupId;
    const members = gid
        ? next.tracks.flatMap((t) => t.elements.filter((e) => e.groupId === gid))
        : [found.el];
    const rawDelta = Math.max(0, newStart) - found.el.timeline_start;
    const minStart = Math.min(...members.map((m) => m.timeline_start));
    const delta = Math.max(rawDelta, -minStart);
    for (const m of members) {
        m.timeline_start = Math.max(0, m.timeline_start + delta);
        if (m.type === "text" && m.timeline_end != null) m.timeline_end += delta;
    }

    if (targetTrackId && targetTrackId !== found.track.id) {
        const target = next.tracks.find((t) => t.id === targetTrackId);
        if (target && kindCompatible(found.el.type, target.kind)) {
            found.track.elements = found.track.elements.filter((e) => e.id !== clipId);
            target.elements.push(found.el);
            target.elements.sort((a, b) => a.timeline_start - b.timeline_start);
        }
    }
    return withDuration(next);
}

function trimStart(data, clipId, newStart) {
    const next = clone(data);
    const found = findClip(next, clipId);
    if (!found) return data;
    const el = found.el;
    const start = Math.max(0, newStart);
    if (el.type === "text") {
        const end = el.timeline_end ?? el.timeline_start + DEFAULT_TEXT_DUR;
        el.timeline_start = Math.min(start, end - MIN_CLIP);
        return withDuration(next);
    }
    const delta = start - el.timeline_start;
    const srcStart = (el.source_start ?? 0) + delta;
    const clampedSrcStart = Math.max(0, Math.min(srcStart, (el.source_end ?? 0) - MIN_CLIP));
    const actualDelta = clampedSrcStart - (el.source_start ?? 0);
    el.source_start = clampedSrcStart;
    el.timeline_start += actualDelta;
    return withDuration(next);
}

function trimEnd(data, clipId, newEnd, sourceMax) {
    const next = clone(data);
    const found = findClip(next, clipId);
    if (!found) return data;
    const el = found.el;
    if (el.type === "text") {
        el.timeline_end = Math.max(el.timeline_start + MIN_CLIP, newEnd);
        return withDuration(next);
    }
    const desiredDur = Math.max(MIN_CLIP, newEnd - el.timeline_start);
    let srcEnd = (el.source_start ?? 0) + desiredDur;
    if (sourceMax != null) srcEnd = Math.min(srcEnd, sourceMax);
    el.source_end = Math.max((el.source_start ?? 0) + MIN_CLIP, srcEnd);
    return withDuration(next);
}

function splitClip(data, clipId, atTime) {
    const next = clone(data);
    const found = findClip(next, clipId);
    if (!found) return data;
    const { track, el } = found;
    const offset = atTime - el.timeline_start;
    if (offset <= MIN_CLIP || offset >= clipDuration(el) - MIN_CLIP) return data;
    const right = clone(el);
    right.id = newId("clip");
    right.timeline_start = atTime;
    if (el.type === "text") {
        el.timeline_end = atTime;
    } else {
        const splitSrc = (el.source_start ?? 0) + offset;
        right.source_start = splitSrc;
        el.source_end = splitSrc;
    }
    const idx = track.elements.findIndex((e) => e.id === clipId);
    track.elements.splice(idx + 1, 0, right);
    return withDuration(next);
}

function deleteClips(data, clipIds) {
    const next = clone(data);
    const set = new Set(clipIds);
    for (const t of next.tracks) t.elements = t.elements.filter((e) => !set.has(e.id));
    return withDuration(next);
}

function rippleDelete(data, clipIds) {
    const set = new Set(clipIds);
    const next = clone(data);
    for (const track of next.tracks) {
        const removed = track.elements.filter((e) => set.has(e.id));
        if (!removed.length) continue;
        const remaining = track.elements.filter((e) => !set.has(e.id));
        for (const el of remaining) {
            let shift = 0;
            for (const r of removed) if (clipEnd(r) <= el.timeline_start + 1e-6) shift += clipDuration(r);
            if (shift > 0) {
                el.timeline_start = Math.max(0, el.timeline_start - shift);
                if (el.type === "text" && el.timeline_end != null) el.timeline_end -= shift;
            }
        }
        track.elements = remaining.sort((a, b) => a.timeline_start - b.timeline_start);
    }
    return withDuration(next);
}

function duplicateClips(data, clipIds) {
    const set = new Set(clipIds);
    const next = clone(data);
    for (const track of next.tracks) {
        const originals = track.elements.filter((e) => set.has(e.id));
        for (const el of originals) {
            const copy = clone(el);
            copy.id = newId("clip");
            const dur = clipDuration(el);
            copy.timeline_start = clipEnd(el);
            if (copy.type === "text") copy.timeline_end = copy.timeline_start + dur;
            track.elements.push(copy);
        }
        track.elements.sort((a, b) => a.timeline_start - b.timeline_start);
    }
    return withDuration(next);
}

function linkClips(data, clipIds) {
    if (clipIds.length < 2) return data;
    const next = clone(data);
    const gid = newId("grp");
    const set = new Set(clipIds);
    for (const t of next.tracks) for (const e of t.elements) if (set.has(e.id)) e.groupId = gid;
    return next;
}

function unlinkClips(data, clipIds) {
    const next = clone(data);
    const set = new Set(clipIds);
    const groups = new Set();
    for (const t of next.tracks) {
        for (const e of t.elements) if (set.has(e.id) && e.groupId) groups.add(e.groupId);
    }
    for (const t of next.tracks) {
        for (const e of t.elements) if (e.groupId && groups.has(e.groupId)) delete e.groupId;
    }
    return next;
}

function addTrack(data, kind, atIndex = 0) {
    const next = clone(data);
    const count = next.tracks.filter((t) => t.kind === kind).length + 1;
    const name = kind === "video" ? `Video ${count}` : kind === "audio" ? `Audio ${count}` : `Text ${count}`;
    const track = { id: newId("trk"), kind, name, order: 0, elements: [] };
    next.tracks.splice(Math.max(0, Math.min(atIndex, next.tracks.length)), 0, track);
    return withDuration(next);
}

function removeTrack(data, trackId) {
    const next = clone(data);
    next.tracks = next.tracks.filter((t) => t.id !== trackId);
    return withDuration(next);
}

function moveTrack(data, trackId, dir) {
    const next = clone(data);
    const i = next.tracks.findIndex((t) => t.id === trackId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= next.tracks.length) return data;
    const tmp = next.tracks[i];
    next.tracks[i] = next.tracks[j];
    next.tracks[j] = tmp;
    return withDuration(next);
}

function setTrackFlags(data, trackId, patch) {
    const next = clone(data);
    const track = next.tracks.find((t) => t.id === trackId);
    if (track) Object.assign(track, patch);
    return next;
}

function updateClips(data, clipIds, patcher) {
    let next = clone(data);
    for (const id of clipIds) {
        const found = findClip(next, id);
        if (!found) continue;
        Object.assign(found.el, patcher(found.el));
    }
    return withDuration(next);
}

function makeTextClip(text, at) {
    return {
        id: newId("clip"),
        type: "text",
        text,
        timeline_start: at,
        timeline_end: at + DEFAULT_TEXT_DUR,
    };
}

function makeMediaClip(type, mediaId, duration, at) {
    const clip = {
        id: newId("clip"),
        type,
        media_id: mediaId,
        source_start: 0,
        source_end: duration || 1,
        timeline_start: at,
    };
    if (type === "video") clip.color = { ...NEUTRAL_COLOR };
    return clip;
}

window.addEventListener("load", () => {
    document.body.innerHTML = `
        <div class="editor-shell">
            <aside class="side-panel assets-panel">
                <div class="panel-head">
                    <span>Assets</span>
                    <input id="assetSearch" class="search" placeholder="Search" />
                </div>
                <div id="assets" class="assets-list"></div>
            </aside>
            <main class="center-panel">
                <div class="transport">
                    <button id="play" class="play" disabled title="Play/pause (Space)">Play</button>
                    <span id="time" class="time">00:00.00 / 00:00.00</span>
                    <span id="saveState" class="save-state">ready</span>
                    <select id="projectSelect" class="project-select" title="Switch project"></select>
                    <button id="newProjectBtn" class="top-btn" title="Create project">New</button>
                    <span class="spacer"></span>
                    <span id="project" class="project"></span>
                    <button id="importBtn" class="top-btn" title="Import video into this project">Import</button>
                    <button id="transcribeBtn" class="top-btn" title="Transcription is still handled by the legacy backend">Transcribe</button>
                    <button id="aiBtn" class="top-btn" title="Show AI edit panel">AI</button>
                    <button id="exportBtn" class="top-btn primary" title="Export current MLT timeline">Export</button>
                </div>
                <div class="tl-toolbar">
                    <button data-action="select" class="tbtn active" title="Select tool (V)">Select</button>
                    <button data-action="transform" class="tbtn" title="Transform mode (W)">Transform</button>
                    <button data-action="crop" class="tbtn" title="Crop mode (C)">Crop</button>
                    <button data-action="textMode" class="tbtn" title="Text mode (X)">Text</button>
                    <button data-action="blade" class="tbtn" title="Blade tool (B)">Blade</button>
                    <span class="tbar-sep"></span>
                    <button data-action="split" class="tbtn" title="Split at playhead (S)">Split</button>
                    <button data-action="delete" class="tbtn" title="Delete selected clip(s)">Delete</button>
                    <button data-action="ripple" class="tbtn" title="Ripple delete selected clip(s)">Ripple</button>
                    <button data-action="duplicate" class="tbtn" title="Duplicate selected clip(s)">Duplicate</button>
                    <button data-action="flipH" class="tbtn" title="Flip horizontal">Flip H</button>
                    <button data-action="flipV" class="tbtn" title="Flip vertical">Flip V</button>
                    <button data-action="rotate90" class="tbtn" title="Rotate 90 degrees">Rotate</button>
                    <button data-action="resetTransform" class="tbtn" title="Reset transform">Reset</button>
                    <button data-action="link" class="tbtn" title="Link selected clips">Link</button>
                    <button data-action="unlink" class="tbtn" title="Unlink selected clips">Unlink</button>
                    <span class="tbar-sep"></span>
                    <button data-action="undo" class="tbtn" title="Undo">Undo</button>
                    <button data-action="redo" class="tbtn" title="Redo">Redo</button>
                    <span class="tbar-sep"></span>
                    <button data-action="addText" class="tbtn" title="Add text at playhead">+ Text</button>
                    <select id="addTrack" class="tbtn tbar-select" title="Add track">
                        <option value="">+ Track...</option>
                        <option value="video">Video track</option>
                        <option value="audio">Audio track</option>
                        <option value="text">Text track</option>
                    </select>
                    <button data-action="trackUp" class="tbtn" title="Move selected track up">Up</button>
                    <button data-action="trackDown" class="tbtn" title="Move selected track down">Down</button>
                    <button data-action="removeTrack" class="tbtn" title="Remove selected track">Remove Track</button>
                    <span class="tbar-spacer"></span>
                    <label class="snap"><input id="snap" type="checkbox" checked /> Snap</label>
                    <button data-action="zoomOut" class="tbtn" title="Zoom out">-</button>
                    <button data-action="zoomIn" class="tbtn" title="Zoom in">+</button>
                </div>
                <div id="tl" class="tl">
                    <div id="tlInner" class="tl-inner">
                        <div class="tl-ruler-row">
                            <div class="tl-corner"></div>
                            <div id="ruler" class="tl-ruler"></div>
                        </div>
                        <div id="tracks" class="tl-tracks"></div>
                        <div id="playhead" class="tl-playhead"><div class="tl-playhead-knob"></div></div>
                    </div>
                </div>
                <div id="status" class="status">connecting...</div>
            </main>
            <aside class="side-panel inspector-panel">
                <div class="panel-head"><span>Inspector</span></div>
                <div id="inspector" class="inspector empty">Select a clip.</div>
                <div id="aiPanel" class="ai-chat hidden">
                    <div class="panel-head ai-head"><span>AI edit</span><button id="closeAi" class="mini">Close</button></div>
                    <div id="aiMessages" class="ai-messages">
                        <div class="bubble assistant">The Qt port is wired to the shared command layer. Try asking for: duplicate selected, ripple delete, add text, fade in, rotate, link clips.</div>
                    </div>
                    <div class="ai-input">
                        <textarea id="aiInput" placeholder="Ask for an edit command"></textarea>
                        <button id="aiSend" class="top-btn primary">Send</button>
                    </div>
                </div>
            </aside>
        </div>`;

    const els = {
        playBtn: document.getElementById("play"),
        time: document.getElementById("time"),
        saveState: document.getElementById("saveState"),
        status: document.getElementById("status"),
        project: document.getElementById("project"),
        ruler: document.getElementById("ruler"),
        tracks: document.getElementById("tracks"),
        inner: document.getElementById("tlInner"),
        playhead: document.getElementById("playhead"),
        toolbar: document.querySelector(".tl-toolbar"),
        inspector: document.getElementById("inspector"),
        assets: document.getElementById("assets"),
        assetSearch: document.getElementById("assetSearch"),
        addTrack: document.getElementById("addTrack"),
        snap: document.getElementById("snap"),
        projectSelect: document.getElementById("projectSelect"),
        newProjectBtn: document.getElementById("newProjectBtn"),
        importBtn: document.getElementById("importBtn"),
        transcribeBtn: document.getElementById("transcribeBtn"),
        aiBtn: document.getElementById("aiBtn"),
        exportBtn: document.getElementById("exportBtn"),
        aiPanel: document.getElementById("aiPanel"),
        closeAi: document.getElementById("closeAi"),
        aiMessages: document.getElementById("aiMessages"),
        aiInput: document.getElementById("aiInput"),
        aiSend: document.getElementById("aiSend"),
    };

    let duration = 0;
    let pxPerSec = 70;
    let playhead = 0;
    let timeline = null;
    let mediaById = {};
    let bridge = null;
    let mode = "select";
    let selectedIds = [];
    let selectedTrackId = null;
    let past = [];
    let future = [];
    let saveTimer = null;
    let mediaQuery = "";
    let currentProjectId = "";

    const laneWidth = () => Math.max(duration + 3, MIN_VIEW_SECONDS) * pxPerSec;
    const selectedId = () => selectedIds[selectedIds.length - 1] || null;
    const selectedClips = () => timeline ? selectedIds.map((id) => findClip(timeline, id)?.el).filter(Boolean) : [];
    const sourceMax = (el) => el.media_id ? mediaById[el.media_id]?.duration_seconds : undefined;
    const quantize = (t) => {
        const fps = timeline?.canvas?.fps || 30;
        return Math.max(0, Math.round(t * fps) / fps);
    };

    function setSaveState(text, cls = "") {
        els.saveState.textContent = text;
        els.saveState.className = `save-state ${cls}`;
    }

    function scheduleSave() {
        if (!bridge || !timeline) return;
        setSaveState("saving...", "busy");
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const payload = JSON.stringify(timeline);
            bridge.saveTimeline(payload, (ok) => {
                setSaveState(ok ? "saved" : "save failed", ok ? "ok" : "bad");
                if (!ok) log("saveTimeline failed");
            });
        }, 450);
    }

    function commit(producer) {
        if (!timeline) return;
        const next = producer(timeline);
        if (next === timeline) return;
        past.push(clone(timeline));
        if (past.length > 100) past.shift();
        future = [];
        timeline = next;
        duration = timeline.duration || computeDuration(timeline);
        renderAll();
        scheduleSave();
    }

    function undo() {
        if (!past.length || !timeline) return;
        future.push(clone(timeline));
        timeline = past.pop();
        selectedIds = [];
        duration = timeline.duration || computeDuration(timeline);
        renderAll();
        scheduleSave();
    }

    function redo() {
        if (!future.length || !timeline) return;
        past.push(clone(timeline));
        timeline = future.pop();
        selectedIds = [];
        duration = timeline.duration || computeDuration(timeline);
        renderAll();
        scheduleSave();
    }

    function positionPlayhead() {
        els.playhead.style.left = `${LEFT_COL + playhead * pxPerSec}px`;
    }

    function renderTime() {
        els.time.textContent = `${formatTime(playhead)} / ${formatTime(duration)}`;
    }

    function renderRuler() {
        const w = laneWidth();
        els.ruler.style.width = `${w}px`;
        els.inner.style.width = `${LEFT_COL + w}px`;
        const interval = niceInterval(80 / pxPerSec);
        const viewSeconds = Math.max(duration + 3, MIN_VIEW_SECONDS);
        let html = "";
        for (let t = 0; t <= viewSeconds + 0.001; t += interval) {
            html += `<div class="tl-tick" style="left:${t * pxPerSec}px"><span>${formatTime(t)}</span></div>`;
        }
        els.ruler.innerHTML = html;
    }

    function renderTracks() {
        if (!timeline) return;
        const w = laneWidth();
        let html = "";
        for (const track of timeline.tracks) {
            const icon = track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T";
            const selTrack = selectedTrackId === track.id ? " sel" : "";
            let clips = "";
            for (const el of track.elements) {
                const dur = clipDuration(el);
                const left = el.timeline_start * pxPerSec;
                const width = Math.max(8, dur * pxPerSec);
                const media = el.media_id ? mediaById[el.media_id] : null;
                const label = el.type === "text" ? (el.text || "Text") : (media ? media.original_filename : "clip");
                const selected = selectedIds.includes(el.id) ? " selected" : "";
                const linked = selectedIds.some((id) => {
                    const f = findClip(timeline, id);
                    return f?.el.groupId && f.el.groupId === el.groupId && !selectedIds.includes(el.id);
                }) ? " linked" : "";
                clips += `<div class="tl-clip ${track.kind}${selected}${linked}${track.locked ? " locked" : ""}" `
                    + `data-clip-id="${escapeHtml(el.id)}" data-track-id="${escapeHtml(track.id)}" `
                    + `style="left:${left}px;width:${width}px" title="${escapeHtml(label)}">`
                    + `<div class="clip-overlay"><span class="label">${escapeHtml(label)}</span><span class="dur">${formatTime(dur)}</span></div>`
                    + `${track.locked ? "" : '<div class="handle left" data-handle="trim-start"></div><div class="handle right" data-handle="trim-end"></div>'}`
                    + `</div>`;
            }
            html += `<div class="tl-track-row kind-${track.kind}${selTrack}" data-track-id="${escapeHtml(track.id)}">`
                + `<div class="tl-ctrl" data-track-select="${escapeHtml(track.id)}">`
                + `<span class="track-kind ${track.kind}">${icon}</span>`
                + `<span class="track-name">${escapeHtml(track.name || track.kind)}</span>`
                + `<button class="track-flag ${track.hidden ? "" : "on"}" data-track-flag="hidden" title="Show/hide">${track.hidden ? "Off" : "On"}</button>`
                + `<button class="track-flag ${track.locked ? "on" : ""}" data-track-flag="locked" title="Lock/unlock">${track.locked ? "Lock" : "Open"}</button>`
                + `</div><div class="tl-lane${track.locked ? " locked" : ""}" data-lane-track="${escapeHtml(track.id)}" style="width:${w}px">${clips}</div></div>`;
        }
        els.tracks.innerHTML = html;
    }

    function renderToolbar() {
        els.toolbar.querySelectorAll("[data-action='select'],[data-action='transform'],[data-action='crop'],[data-action='textMode'],[data-action='blade']").forEach((b) => {
            const actionMode = b.dataset.action === "textMode" ? "text" : b.dataset.action;
            b.classList.toggle("active", actionMode === mode);
        });
        els.snap.checked = !!els.snap.checked;
    }

    function renderAssets() {
        const q = mediaQuery.trim().toLowerCase();
        const rows = Object.values(mediaById).filter((m) => {
            if (!q) return true;
            return [m.original_filename, m.category, ...(m.tags || [])].join(" ").toLowerCase().includes(q);
        });
        els.assets.innerHTML = rows.length ? rows.map((m) => `
            <button class="asset-row" data-asset-id="${escapeHtml(m.id)}" title="Add at playhead">
                <span class="asset-kind">${m.type === "audio" ? "A" : "V"}</span>
                <span class="asset-name">${escapeHtml(m.original_filename)}</span>
                <span class="asset-dur">${formatTime(m.duration_seconds || 0)}</span>
            </button>`).join("") : `<div class="empty-small">No assets.</div>`;
    }

    function refreshProjects() {
        if (!bridge) return;
        bridge.listProjects((json) => {
            let projects = [];
            try {
                projects = JSON.parse(json || "[]");
            } catch {
                projects = [];
            }
            els.projectSelect.innerHTML = projects.map((p) =>
                `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.media_count ? ` (${p.media_count})` : ""}</option>`
            ).join("");
            if (currentProjectId) els.projectSelect.value = currentProjectId;
        });
    }

    function field(label, id, value, opts = {}) {
        const type = opts.type || "range";
        const attr = type === "range"
            ? `min="${opts.min}" max="${opts.max}" step="${opts.step || 0.01}"`
            : `step="${opts.step || 0.1}"`;
        return `<label class="insp-field"><span>${label}<b>${type === "range" ? Number(value).toFixed(2) : ""}</b></span>`
            + `<input data-insp="${id}" type="${type}" value="${escapeHtml(value)}" ${attr}></label>`;
    }

    function renderInspector() {
        const clips = selectedClips();
        if (!clips.length) {
            els.inspector.className = "inspector empty";
            els.inspector.innerHTML = "Select a clip.";
            return;
        }
        els.inspector.className = "inspector";
        const clip = clips[0];
        const visualIds = clips.filter((c) => c.type !== "audio").map((c) => c.id);
        const videoIds = clips.filter((c) => c.type === "video").map((c) => c.id);
        const audioIds = clips.filter((c) => c.type === "video" || c.type === "audio").map((c) => c.id);
        const tf = { ...NEUTRAL_TRANSFORM, ...(clip.transform || {}) };
        const color = { ...NEUTRAL_COLOR, ...(clip.color || {}) };
        const crop = clip.crop || null;
        const mask = clip.mask || null;
        const chroma = { ...DEFAULT_CHROMA, ...(clip.chroma || {}) };

        els.inspector.dataset.visualIds = JSON.stringify(visualIds);
        els.inspector.dataset.videoIds = JSON.stringify(videoIds);
        els.inspector.dataset.audioIds = JSON.stringify(audioIds);
        els.inspector.innerHTML = `
            <div class="insp-head"><span>${clips.length > 1 ? `${clips.length} clips` : escapeHtml(clip.type)}</span></div>
            ${clip.type === "text" ? `<label class="insp-field"><span>Text</span><input data-insp="text" type="text" value="${escapeHtml(clip.text || "")}"></label>` : ""}
            <section><div class="insp-title">Layer</div>
                ${field("Opacity", "opacity", clip.opacity ?? 1, { min: 0, max: 1, step: 0.02 })}
                ${field("Scale", "scale", tf.scale, { min: 0.1, max: 3, step: 0.02 })}
                ${field("X", "x", tf.x, { min: -1, max: 1, step: 0.01 })}
                ${field("Y", "y", tf.y, { min: -1, max: 1, step: 0.01 })}
                ${field("Rotate", "rotation", tf.rotation, { min: -180, max: 180, step: 1 })}
                <div class="insp-inline">
                    <label><input data-insp="flipH" type="checkbox" ${clip.flipH ? "checked" : ""}> Flip H</label>
                    <label><input data-insp="flipV" type="checkbox" ${clip.flipV ? "checked" : ""}> Flip V</label>
                </div>
            </section>
            <section><div class="insp-title">Transitions</div>
                ${field("Fade in", "fadeIn", clip.fadeIn ?? 0, { type: "number", step: 0.1 })}
                ${field("Fade out", "fadeOut", clip.fadeOut ?? 0, { type: "number", step: 0.1 })}
            </section>
            ${videoIds.length ? `<section><div class="insp-title">Color</div>
                ${field("Brightness", "brightness", color.brightness, { min: 0.2, max: 2, step: 0.05 })}
                ${field("Contrast", "contrast", color.contrast, { min: 0.2, max: 2, step: 0.05 })}
                ${field("Saturation", "saturation", color.saturation, { min: 0, max: 2, step: 0.05 })}
            </section>
            <section><div class="insp-title">Crop <label><input data-insp="cropOn" type="checkbox" ${crop ? "checked" : ""}> on</label></div>
                ${crop ? field("Crop X", "cropX", crop.x, { min: 0, max: 0.95, step: 0.01 }) + field("Crop Y", "cropY", crop.y, { min: 0, max: 0.95, step: 0.01 }) + field("Crop W", "cropW", crop.w, { min: 0.05, max: 1, step: 0.01 }) + field("Crop H", "cropH", crop.h, { min: 0.05, max: 1, step: 0.01 }) : ""}
            </section>
            <section><div class="insp-title">Green Screen <label><input data-insp="chromaOn" type="checkbox" ${clip.chroma?.enabled ? "checked" : ""}> on</label></div>
                ${clip.chroma?.enabled ? `<label class="insp-field"><span>Key color</span><input data-insp="chromaColor" type="color" value="${escapeHtml(chroma.color)}"></label>` + field("Similarity", "similarity", chroma.similarity, { min: 0, max: 1, step: 0.02 }) + field("Smooth", "smoothness", chroma.smoothness, { min: 0, max: 0.5, step: 0.01 }) : ""}
            </section>
            <section><div class="insp-title">Mask <label><input data-insp="maskOn" type="checkbox" ${mask ? "checked" : ""}> on</label></div>
                ${mask ? field("Mask X", "maskX", mask.x, { min: 0, max: 1, step: 0.01 }) + field("Mask Y", "maskY", mask.y, { min: 0, max: 1, step: 0.01 }) + field("Mask W", "maskW", mask.w, { min: 0.05, max: 1, step: 0.01 }) + field("Mask H", "maskH", mask.h, { min: 0.05, max: 1, step: 0.01 }) : ""}
            </section>` : ""}
            ${audioIds.length ? `<section><div class="insp-title">Audio</div>
                ${field("Volume", "volume", clip.volume ?? 1, { min: 0, max: 1, step: 0.02 })}
                ${field("Audio fade in", "audioFadeIn", clip.audioFadeIn ?? 0, { type: "number", step: 0.1 })}
                ${field("Audio fade out", "audioFadeOut", clip.audioFadeOut ?? 0, { type: "number", step: 0.1 })}
            </section>` : ""}`;
    }

    function renderAll() {
        renderRuler();
        renderTracks();
        renderAssets();
        renderInspector();
        renderToolbar();
        positionPlayhead();
        renderTime();
    }

    function setSelection(ids) {
        selectedIds = ids.filter(Boolean);
        renderTracks();
        renderInspector();
    }

    function applyProject(timelineJson, mediaJson, name) {
        try {
            timeline = timelineJson ? JSON.parse(timelineJson) : null;
        } catch (err) {
            console.error("bad timeline json", err);
            timeline = null;
        }
        try {
            mediaById = mediaJson ? JSON.parse(mediaJson) : {};
            for (const [id, m] of Object.entries(mediaById)) m.id = id;
        } catch {
            mediaById = {};
        }
        if (timeline) {
            timeline.tracks ||= [];
            duration = timeline.duration || computeDuration(timeline);
            els.project.textContent = name || "";
            bridge?.projectId((pid) => {
                currentProjectId = pid || "";
                if (currentProjectId) els.projectSelect.value = currentProjectId;
            });
            const fitPx = duration > 0 ? Math.max(8, (window.innerWidth - 520 - LEFT_COL) / duration) : 70;
            pxPerSec = Math.min(120, fitPx);
        }
        renderAll();
    }

    function timeAtX(clientX) {
        const rect = els.ruler.getBoundingClientRect();
        const viewSeconds = Math.max(duration + 3, MIN_VIEW_SECONDS);
        return quantize(Math.min(Math.max(0, (clientX - rect.left) / pxPerSec), viewSeconds));
    }

    function moveLine(t) {
        playhead = t;
        positionPlayhead();
        renderTime();
    }

    let scrubbing = false;
    let seekBusy = false;
    let pendingT = null;
    let seekTimer = null;
    let lastIssueAt = 0;
    let decodeEma = 200;
    const safetyMs = () => Math.min(2000, Math.max(150, decodeEma * 2.5));

    function issueSeek(t) {
        seekBusy = true;
        lastIssueAt = performance.now();
        if (bridge) bridge.seek(t);
        clearTimeout(seekTimer);
        seekTimer = setTimeout(() => {
            seekBusy = false;
            flushPending();
        }, safetyMs());
    }

    function flushPending() {
        if (pendingT != null && !seekBusy) {
            const t = pendingT;
            pendingT = null;
            issueSeek(t);
        }
    }

    function requestSeek(t) {
        if (seekBusy) pendingT = t;
        else issueSeek(t);
    }

    function onScrubMove(clientX) {
        const t = timeAtX(clientX);
        moveLine(t);
        requestSeek(t);
    }

    function trackAtY(clientY) {
        for (const lane of document.querySelectorAll("[data-lane-track]")) {
            const r = lane.getBoundingClientRect();
            if (clientY >= r.top && clientY <= r.bottom) {
                return timeline.tracks.find((t) => t.id === lane.dataset.laneTrack) || null;
            }
        }
        return null;
    }

    function beginClipDrag(e, clipEl, handle) {
        if (!timeline) return;
        const clipId = clipEl.dataset.clipId;
        const found = findClip(timeline, clipId);
        if (!found) return;
        const { track, el } = found;
        if (track.locked) {
            setSelection([clipId]);
            return;
        }
        if (!handle && mode === "blade") {
            const rect = clipEl.getBoundingClientRect();
            commit((d) => splitClip(d, clipId, quantize(el.timeline_start + (e.clientX - rect.left) / pxPerSec)));
            return;
        }
        if (!handle && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            setSelection(selectedIds.includes(clipId) ? selectedIds.filter((id) => id !== clipId) : [...selectedIds, clipId]);
            return;
        }
        setSelection([clipId]);
        const base = {
            mode: handle || "move",
            startX: e.clientX,
            startY: e.clientY,
            baseStart: el.timeline_start,
            baseEnd: clipEnd(el),
            dur: clipDuration(el),
            lastStart: el.timeline_start,
            lastEnd: clipEnd(el),
            dropTrackId: track.id,
            valid: true,
        };
        const applyGeometry = (s, end) => {
            clipEl.style.left = `${s * pxPerSec}px`;
            clipEl.style.width = `${Math.max(8, (end - s) * pxPerSec)}px`;
        };
        const snapCandidates = () => {
            const cands = [0, playhead];
            for (const other of track.elements) {
                if (other.id !== el.id) cands.push(other.timeline_start, clipEnd(other));
            }
            return cands;
        };
        const onMove = (ev) => {
            const dx = (ev.clientX - base.startX) / pxPerSec;
            const thr = 8 / pxPerSec;
            if (base.mode === "move") {
                let s = Math.max(0, base.baseStart + dx);
                if (els.snap.checked) {
                    const end = s + base.dur;
                    let adj = 0;
                    let best = thr;
                    for (const c of snapCandidates()) {
                        const ds = c - s;
                        if (Math.abs(ds) < best) { best = Math.abs(ds); adj = ds; }
                        const de = c - end;
                        if (Math.abs(de) < best) { best = Math.abs(de); adj = de; }
                    }
                    s = Math.max(0, s + adj);
                }
                base.lastStart = quantize(s);
                base.lastEnd = base.lastStart + base.dur;
                const target = trackAtY(ev.clientY);
                base.dropTrackId = target ? target.id : track.id;
                const exclude = new Set(linkedIds(timeline, clipId));
                const clashes = target && rangeOverlaps(target, base.lastStart, base.lastEnd, exclude);
                base.valid = !!target && kindCompatible(el.type, target.kind) && !clashes && !target.locked;
                clipEl.style.transform = `translateY(${ev.clientY - base.startY}px)`;
                clipEl.classList.toggle("invalid", !base.valid);
            } else if (base.mode === "trim-start") {
                let s = Math.min(Math.max(0, base.baseStart + dx), base.baseEnd - MIN_CLIP);
                if (els.snap.checked) for (const c of snapCandidates()) if (Math.abs(c - s) < thr && c < base.baseEnd - MIN_CLIP) s = c;
                base.lastStart = quantize(s);
                base.lastEnd = base.baseEnd;
            } else {
                let end = Math.max(base.baseStart + MIN_CLIP, base.baseEnd + dx);
                if (els.snap.checked) for (const c of snapCandidates()) if (Math.abs(c - end) < thr && c > base.baseStart + MIN_CLIP) end = c;
                base.lastStart = base.baseStart;
                base.lastEnd = quantize(end);
            }
            clipEl.classList.add("dragging");
            applyGeometry(base.lastStart, base.lastEnd);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            clipEl.style.transform = "";
            clipEl.classList.remove("dragging", "invalid");
            if (base.mode === "move") {
                const changedTrack = base.valid && base.dropTrackId !== track.id;
                const changedTime = Math.abs(base.lastStart - base.baseStart) > 1e-6;
                if (base.valid && (changedTrack || changedTime)) {
                    commit((d) => moveClipGroup(d, clipId, base.lastStart, changedTrack ? base.dropTrackId : undefined));
                } else {
                    applyGeometry(base.baseStart, base.baseEnd);
                }
            } else if (base.mode === "trim-start" && Math.abs(base.lastStart - base.baseStart) > 1e-6) {
                commit((d) => trimStart(d, clipId, base.lastStart));
            } else if (base.mode === "trim-end" && Math.abs(base.lastEnd - base.baseEnd) > 1e-6) {
                commit((d) => trimEnd(d, clipId, base.lastEnd, sourceMax(el)));
            }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        e.preventDefault();
        e.stopPropagation();
    }

    function placeAsset(mediaId) {
        if (!timeline) return;
        const m = mediaById[mediaId];
        if (!m) return;
        const mediaType = m.type === "audio" ? "audio" : "video";
        let track = selectedTrackId ? timeline.tracks.find((t) => t.id === selectedTrackId && t.kind === mediaType) : null;
        track ||= [...timeline.tracks].reverse().find((t) => t.kind === mediaType);
        if (!track) {
            commit((d) => addTrack(d, mediaType, 0));
            track = timeline.tracks.find((t) => t.kind === mediaType);
        }
        if (!track) return;
        const clip = makeMediaClip(mediaType, mediaId, m.duration_seconds || 1, playhead);
        commit((d) => {
            const next = clone(d);
            const t = next.tracks.find((x) => x.id === track.id);
            if (t) {
                t.elements.push(clip);
                t.elements.sort((a, b) => a.timeline_start - b.timeline_start);
            }
            return withDuration(next);
        });
    }

    document.getElementById("tl").addEventListener("pointerdown", (e) => {
        const clip = e.target.closest?.("[data-clip-id]");
        if (clip) {
            beginClipDrag(e, clip, e.target.dataset.handle || null);
            return;
        }
        const flag = e.target.dataset?.trackFlag;
        if (flag) {
            const row = e.target.closest("[data-track-id]");
            const tid = row?.dataset.trackId;
            if (tid) {
                commit((d) => {
                    const tr = d.tracks.find((t) => t.id === tid);
                    return tr ? setTrackFlags(d, tid, { [flag]: !tr[flag] }) : d;
                });
            }
            e.stopPropagation();
            return;
        }
        const trSel = e.target.closest?.("[data-track-select]");
        if (trSel) {
            selectedTrackId = trSel.dataset.trackSelect;
            renderTracks();
            e.stopPropagation();
            return;
        }
        const rectLeft = els.ruler.getBoundingClientRect().left;
        if (e.clientX >= rectLeft) {
            selectedIds = [];
            renderTracks();
            renderInspector();
            scrubbing = true;
            if (bridge) bridge.pause();
            onScrubMove(e.clientX);
            e.preventDefault();
        }
    });

    window.addEventListener("pointermove", (e) => { if (scrubbing) onScrubMove(e.clientX); });
    window.addEventListener("pointerup", () => {
        if (!scrubbing) return;
        scrubbing = false;
        flushPending();
    });

    els.toolbar.addEventListener("click", (e) => {
        const action = e.target.dataset?.action;
        if (!action) return;
        const ids = selectedIds.slice();
        if (["select", "transform", "crop", "textMode", "blade"].includes(action)) {
            mode = action === "textMode" ? "text" : action;
            renderToolbar();
        } else if (action === "split" && selectedId()) {
            commit((d) => splitClip(d, selectedId(), playhead));
        } else if (action === "delete" && ids.length) {
            commit((d) => deleteClips(d, ids));
            selectedIds = [];
        } else if (action === "ripple" && ids.length) {
            commit((d) => rippleDelete(d, ids));
            selectedIds = [];
        } else if (action === "duplicate" && ids.length) {
            commit((d) => duplicateClips(d, ids));
        } else if (action === "flipH" && ids.length) {
            commit((d) => updateClips(d, ids, (el) => ({ flipH: !el.flipH })));
        } else if (action === "flipV" && ids.length) {
            commit((d) => updateClips(d, ids, (el) => ({ flipV: !el.flipV })));
        } else if (action === "rotate90" && ids.length) {
            commit((d) => updateClips(d, ids, (el) => ({
                transform: { ...NEUTRAL_TRANSFORM, ...(el.transform || {}), rotation: ((el.transform?.rotation || 0) + 90) % 360 },
            })));
        } else if (action === "resetTransform" && ids.length) {
            commit((d) => updateClips(d, ids, () => ({
                transform: { ...NEUTRAL_TRANSFORM },
                flipH: false,
                flipV: false,
            })));
        } else if (action === "link" && ids.length > 1) {
            commit((d) => linkClips(d, ids));
        } else if (action === "unlink" && ids.length) {
            commit((d) => unlinkClips(d, ids));
        } else if (action === "undo") {
            undo();
        } else if (action === "redo") {
            redo();
        } else if (action === "addText") {
            let track = selectedTrackId ? timeline.tracks.find((t) => t.id === selectedTrackId && t.kind === "text") : null;
            track ||= timeline.tracks.find((t) => t.kind === "text");
            if (!track) return;
            commit((d) => {
                const next = clone(d);
                const t = next.tracks.find((x) => x.id === track.id);
                if (t) t.elements.push(makeTextClip("New text", playhead));
                return withDuration(next);
            });
        } else if (action === "trackUp" && selectedTrackId) {
            commit((d) => moveTrack(d, selectedTrackId, -1));
        } else if (action === "trackDown" && selectedTrackId) {
            commit((d) => moveTrack(d, selectedTrackId, 1));
        } else if (action === "removeTrack" && selectedTrackId) {
            const tr = timeline.tracks.find((t) => t.id === selectedTrackId);
            if (tr && tr.elements.length && !window.confirm(`Remove "${tr.name}" and its clips?`)) return;
            commit((d) => removeTrack(d, selectedTrackId));
            selectedTrackId = null;
        } else if (action === "zoomOut") {
            pxPerSec = Math.max(10, pxPerSec / 1.4);
            renderAll();
        } else if (action === "zoomIn") {
            pxPerSec = Math.min(600, pxPerSec * 1.4);
            renderAll();
        }
    });

    els.addTrack.addEventListener("change", (e) => {
        if (!e.target.value) return;
        commit((d) => addTrack(d, e.target.value, 0));
        e.target.value = "";
    });

    els.assets.addEventListener("click", (e) => {
        const row = e.target.closest?.("[data-asset-id]");
        if (row) placeAsset(row.dataset.assetId);
    });
    els.assetSearch.addEventListener("input", (e) => {
        mediaQuery = e.target.value;
        renderAssets();
    });

    els.inspector.addEventListener("input", (e) => {
        const key = e.target.dataset?.insp;
        if (!key) return;
        const visualIds = JSON.parse(els.inspector.dataset.visualIds || "[]");
        const videoIds = JSON.parse(els.inspector.dataset.videoIds || "[]");
        const audioIds = JSON.parse(els.inspector.dataset.audioIds || "[]");
        const value = e.target.type === "checkbox" ? e.target.checked : (e.target.type === "text" || e.target.type === "color" ? e.target.value : Number(e.target.value));
        const patch = (ids, fn) => commit((d) => updateClips(d, ids, fn));
        const tfPatch = (p) => patch(visualIds, (el) => ({ transform: { ...NEUTRAL_TRANSFORM, ...(el.transform || {}), ...p } }));
        const colorPatch = (p) => patch(videoIds, (el) => ({ color: { ...NEUTRAL_COLOR, ...(el.color || {}), ...p } }));
        if (key === "text") patch(selectedIds, () => ({ text: value }));
        else if (key === "opacity") patch(visualIds, () => ({ opacity: value }));
        else if (["scale", "x", "y", "rotation"].includes(key)) tfPatch({ [key]: value });
        else if (key === "flipH" || key === "flipV") patch(visualIds, () => ({ [key]: value }));
        else if (key === "fadeIn" || key === "fadeOut") patch(visualIds, () => ({ [key]: Math.max(0, value) }));
        else if (["brightness", "contrast", "saturation"].includes(key)) colorPatch({ [key]: value });
        else if (key === "volume" || key === "audioFadeIn" || key === "audioFadeOut") patch(audioIds, () => ({ [key]: Math.max(0, value) }));
        else if (key === "cropOn") patch(videoIds, () => ({ crop: value ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : null }));
        else if (key.startsWith("crop")) {
            const map = { cropX: "x", cropY: "y", cropW: "w", cropH: "h" };
            patch(videoIds, (el) => ({ crop: { x: 0, y: 0, w: 1, h: 1, ...(el.crop || {}), [map[key]]: value } }));
        } else if (key === "maskOn") patch(videoIds, () => ({ mask: value ? { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } : null }));
        else if (key.startsWith("mask")) {
            const map = { maskX: "x", maskY: "y", maskW: "w", maskH: "h" };
            patch(videoIds, (el) => ({ mask: { x: 0.2, y: 0.2, w: 0.6, h: 0.6, ...(el.mask || {}), [map[key]]: value } }));
        } else if (key === "chromaOn") patch(videoIds, (el) => ({ chroma: { ...DEFAULT_CHROMA, ...(el.chroma || {}), enabled: value } }));
        else if (key === "chromaColor" || key === "similarity" || key === "smoothness") {
            const map = { chromaColor: "color", similarity: "similarity", smoothness: "smoothness" };
            patch(videoIds, (el) => ({ chroma: { ...DEFAULT_CHROMA, ...(el.chroma || {}), enabled: true, [map[key]]: value } }));
        }
    });

    els.playBtn.addEventListener("click", () => bridge && bridge.togglePlay());

    els.projectSelect.addEventListener("change", () => {
        const pid = els.projectSelect.value;
        if (!pid || !bridge || pid === currentProjectId) return;
        setSaveState("opening...", "busy");
        bridge.openProjectById(pid, (ok) => {
            setSaveState(ok ? "ready" : "open failed", ok ? "" : "bad");
            if (ok) {
                currentProjectId = pid;
                selectedIds = [];
                selectedTrackId = null;
                past = [];
                future = [];
            }
        });
    });

    els.newProjectBtn.addEventListener("click", () => {
        if (!bridge) return;
        const name = window.prompt("Project name", "Untitled Project");
        if (!name?.trim()) return;
        setSaveState("creating...", "busy");
        bridge.createProject(name.trim(), (pid) => {
            setSaveState(pid ? "created" : "create failed", pid ? "ok" : "bad");
            if (pid) {
                currentProjectId = pid;
                refreshProjects();
            }
        });
    });

    els.importBtn.addEventListener("click", () => {
        if (!bridge) return;
        bridge.pickVideoFile((path) => {
            if (!path) return;
            const copy = window.confirm("Copy this media into the project folder?\n\nCancel will reference it in place.");
            setSaveState("importing...", "busy");
            bridge.importMedia(path, copy, (mediaId) => {
                if (!mediaId) {
                    setSaveState("import failed", "bad");
                    return;
                }
                setSaveState("imported", "ok");
                refreshProjects();
                setTimeout(() => placeAsset(mediaId), 50);
            });
        });
    });

    els.exportBtn.addEventListener("click", () => {
        if (!bridge) return;
        const suggested = `${(els.project.textContent || "export").replace(/[^\w .-]/g, "_")}.mp4`;
        bridge.pickExportPath(suggested, (path) => {
            if (!path) return;
            setSaveState("exporting...", "busy");
            bridge.exportCurrent(path, (ok) => {
                setSaveState(ok ? "exported" : "export failed", ok ? "ok" : "bad");
                if (ok) window.alert(`Exported:\n${path}`);
            });
        });
    });

    els.transcribeBtn.addEventListener("click", () => {
        if (!bridge || !timeline) return;
        bridge.transcriptJson((json) => {
            let segments = [];
            try {
                segments = JSON.parse(json || "{}").segments || [];
            } catch {
                segments = [];
            }
            if (!segments.length) {
                window.alert("No transcript is stored for this project yet. Run transcription in the local backend/legacy app, then this Qt port can apply it as editable text clips.");
                return;
            }
            const existingText = timeline.tracks.filter((t) => t.kind === "text").some((t) => t.elements.length);
            if (existingText && !window.confirm("This project already has text clips. Add transcript captions anyway?")) return;
            commit((d) => {
                let next = d;
                let textTrack = next.tracks.find((t) => t.kind === "text");
                if (!textTrack) {
                    next = addTrack(next, "text", 0);
                    textTrack = next.tracks.find((t) => t.kind === "text");
                }
                if (!textTrack) return d;
                next = clone(next);
                const target = next.tracks.find((t) => t.id === textTrack.id);
                for (const s of segments) {
                    const clip = makeTextClip(s.text || "", s.start_seconds || 0);
                    clip.timeline_end = Math.max((s.start_seconds || 0) + MIN_CLIP, s.end_seconds || ((s.start_seconds || 0) + DEFAULT_TEXT_DUR));
                    target.elements.push(clip);
                }
                target.elements.sort((a, b) => a.timeline_start - b.timeline_start);
                return withDuration(next);
            });
            setSaveState("captions added", "ok");
        });
    });

    els.aiBtn.addEventListener("click", () => {
        els.aiPanel.classList.toggle("hidden");
    });
    els.closeAi.addEventListener("click", () => {
        els.aiPanel.classList.add("hidden");
    });

    function addAiMessage(role, text) {
        const div = document.createElement("div");
        div.className = `bubble ${role}`;
        div.textContent = text;
        els.aiMessages.appendChild(div);
        els.aiMessages.scrollTop = els.aiMessages.scrollHeight;
    }

    function runLocalAiCommand(text) {
        const q = text.toLowerCase();
        const ids = selectedIds.slice();
        if (q.includes("duplicate") && ids.length) {
            commit((d) => duplicateClips(d, ids));
            return "Duplicated the selected clip(s).";
        }
        if (q.includes("ripple") && ids.length) {
            commit((d) => rippleDelete(d, ids));
            selectedIds = [];
            return "Ripple-deleted the selected clip(s).";
        }
        if ((q.includes("delete") || q.includes("remove")) && ids.length) {
            commit((d) => deleteClips(d, ids));
            selectedIds = [];
            return "Deleted the selected clip(s).";
        }
        if (q.includes("split") && selectedId()) {
            commit((d) => splitClip(d, selectedId(), playhead));
            return "Split the selected clip at the playhead.";
        }
        if (q.includes("rotate") && ids.length) {
            commit((d) => updateClips(d, ids, (el) => ({
                transform: { ...NEUTRAL_TRANSFORM, ...(el.transform || {}), rotation: ((el.transform?.rotation || 0) + 90) % 360 },
            })));
            return "Rotated the selected clip(s) by 90 degrees.";
        }
        if (q.includes("fade") && ids.length) {
            commit((d) => updateClips(d, ids, () => ({ fadeIn: 0.5, fadeOut: 0.5 })));
            return "Added half-second visual fades to the selected clip(s).";
        }
        if (q.includes("link") && !q.includes("unlink") && ids.length > 1) {
            commit((d) => linkClips(d, ids));
            return "Linked the selected clip(s).";
        }
        if (q.includes("unlink") && ids.length) {
            commit((d) => unlinkClips(d, ids));
            return "Unlinked the selected clip group.";
        }
        if (q.includes("text")) {
            let track = selectedTrackId ? timeline.tracks.find((t) => t.id === selectedTrackId && t.kind === "text") : null;
            track ||= timeline.tracks.find((t) => t.kind === "text");
            if (!track) return "Add a text track first.";
            commit((d) => {
                const next = clone(d);
                const t = next.tracks.find((x) => x.id === track.id);
                if (t) t.elements.push(makeTextClip("New text", playhead));
                return withDuration(next);
            });
            return "Added a text clip at the playhead.";
        }
        return "I can apply local command-layer edits here: duplicate, split, delete, ripple delete, add text, fade, rotate, link, and unlink. Full model-backed AI chat still needs the native AI service wiring.";
    }

    els.aiSend.addEventListener("click", () => {
        const text = els.aiInput.value.trim();
        if (!text) return;
        els.aiInput.value = "";
        addAiMessage("user", text);
        addAiMessage("assistant", runLocalAiCommand(text));
    });
    els.aiInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            els.aiSend.click();
        }
    });

    window.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
        if (e.code === "Space") {
            bridge?.togglePlay();
            e.preventDefault();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
            redo();
            e.preventDefault();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
            undo();
            e.preventDefault();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedIds.length) {
            commit((d) => duplicateClips(d, selectedIds));
            e.preventDefault();
        } else if (e.key === "Delete" || e.key === "Backspace") {
            if (selectedIds.length) {
                commit((d) => e.shiftKey ? rippleDelete(d, selectedIds) : deleteClips(d, selectedIds));
                selectedIds = [];
            }
        } else if (e.key.toLowerCase() === "s") {
            if (selectedId()) commit((d) => splitClip(d, selectedId(), playhead));
        } else if (e.key.toLowerCase() === "b") {
            mode = "blade";
            renderToolbar();
        } else if (e.key.toLowerCase() === "v") {
            mode = "select";
            renderToolbar();
        } else if (e.key.toLowerCase() === "w") {
            mode = "transform";
            renderToolbar();
        } else if (e.key.toLowerCase() === "c") {
            mode = "crop";
            renderToolbar();
        } else if (e.key.toLowerCase() === "x") {
            mode = "text";
            renderToolbar();
        }
    });

    new QWebChannel(qt.webChannelTransport, (channel) => {
        bridge = channel.objects.bridge;
        window.bridge = bridge;
        logBridge = bridge;
        log("channel ready");

        bridge.durationSeconds((d) => {
            duration = d;
            els.playBtn.disabled = !(d > 0);
            renderAll();
        });
        bridge.playing((p) => {
            els.playBtn.textContent = p ? "Pause" : "Play";
        });
        bridge.timelineJson((tj) => {
            bridge.mediaJson((mj) => {
                bridge.projectName((nm) => applyProject(tj, mj, nm));
            });
        });
        refreshProjects();

        bridge.opened.connect((d) => {
            duration = d;
            els.playBtn.disabled = !(d > 0);
            renderAll();
        });
        bridge.positionChanged.connect((pos, dur) => {
            duration = dur || duration;
            if (scrubbing || seekBusy) {
                if (seekBusy && lastIssueAt) {
                    const lat = performance.now() - lastIssueAt;
                    decodeEma = decodeEma * 0.7 + lat * 0.3;
                }
                seekBusy = false;
                clearTimeout(seekTimer);
                flushPending();
            } else {
                playhead = pos;
                positionPlayhead();
                renderTime();
            }
        });
        bridge.playingChanged.connect((p) => {
            els.playBtn.textContent = p ? "Pause" : "Play";
        });
        bridge.projectLoaded.connect((tj, mj, nm) => applyProject(tj, mj, nm));

        els.status.textContent = "connected to engine";
        setSaveState("ready");
    });
});
