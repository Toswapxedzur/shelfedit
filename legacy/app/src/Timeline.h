#pragma once

#include <QHash>
#include <QString>
#include <QVector>

// Data model mirrored from the legacy timeline JSON (stored in the SQLite DB).
// Times are in SECONDS (as in the JSON); the tractor builder converts to frames.

struct MediaInfo
{
    QString id;
    QString path; // resolved playable path (proxy if available, else original)
    QString filename;
    double duration = 0.0;
    int width = 0;
    int height = 0;
};

struct ClipInfo
{
    QString id;
    QString kind; // "video" | "audio" | "text"
    QString mediaId;
    double sourceStart = 0.0;
    double sourceEnd = 0.0;
    double timelineStart = 0.0;
    double timelineEnd = 0.0; // text clips
    QString text;

    double opacity = 1.0;
    double fadeIn = 0.0;
    double fadeOut = 0.0;
    double volume = 1.0;
    double audioFadeIn = 0.0;
    double audioFadeOut = 0.0;

    double brightness = 1.0;
    double contrast = 1.0;
    double saturation = 1.0;

    double scale = 1.0;
    double x = 0.0;
    double y = 0.0;
    double rotation = 0.0;
    bool flipH = false;
    bool flipV = false;

    bool hasCrop = false;
    double cropX = 0.0;
    double cropY = 0.0;
    double cropW = 1.0;
    double cropH = 1.0;

    bool hasMask = false;
    double maskX = 0.0;
    double maskY = 0.0;
    double maskW = 1.0;
    double maskH = 1.0;

    bool chromaEnabled = false;
    QString chromaColor = "#00ff00";
    double chromaSimilarity = 0.4;
    double chromaSmoothness = 0.12;
};

struct TrackInfo
{
    QString id;
    QString kind; // "video" | "audio" | "text"
    QString name;
    int order = 0;
    bool hidden = false;
    bool locked = false;
    QVector<ClipInfo> clips;
};

struct ProjectData
{
    bool valid = false;
    QString id;
    QString name;

    double duration = 0.0;
    int canvasW = 1920;
    int canvasH = 1080;
    double fps = 30.0;

    QVector<TrackInfo> tracks;
    QHash<QString, MediaInfo> media;

    // Raw payloads handed to the HTML UI verbatim.
    QString rawTimelineJson; // the timeline JSON as stored
    QString mediaJson;       // { mediaId: {filename,duration,width,height} }
};

// Load a project + its latest timeline from the legacy SQLite DB. If projectId
// is empty, pick a sensible default (a project that has media and a timeline).
ProjectData loadProject(const QString &dbPath, const QString &projectId = QString());

// Persist the working timeline JSON for a project. This mirrors the legacy
// FastAPI PUT /timeline behavior: update the latest working timeline row.
bool saveProjectTimeline(const QString &dbPath, const QString &projectId,
                         const QString &timelineJson, QString *error = nullptr);

// Default DB path: ~/.local_ai_video_editor/shelfedit.db
QString defaultDbPath();
