#include "Timeline.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QUuid>
#include <QVariant>

QString defaultDbPath()
{
    return QDir::homePath() + "/.local_ai_video_editor/shelfedit.db";
}

namespace {

QString appDataDir()
{
    return QDir::homePath() + "/.local_ai_video_editor";
}

// Prefer a preview proxy (already downscaled) if one exists on disk, else the
// original/local path from the DB.
QString resolvePlayablePath(const QString &projectId, const QString &mediaId,
                            const QString &localPath)
{
    const QString proxy = QString("%1/projects/%2/media/proxy/%3.mp4")
                              .arg(appDataDir(), projectId, mediaId);
    if (QFileInfo::exists(proxy)) {
        return proxy;
    }
    return localPath;
}

double numberOr(const QJsonObject &obj, const char *key, double fallback)
{
    const QJsonValue v = obj.value(QLatin1String(key));
    return v.isDouble() ? v.toDouble() : fallback;
}

bool hasObject(const QJsonObject &obj, const char *key)
{
    return obj.value(QLatin1String(key)).isObject();
}

} // namespace

ProjectData loadProject(const QString &dbPath, const QString &projectId)
{
    ProjectData out;

    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(dbPath);
    if (!db.open()) {
        return out;
    }

    // Choose the project: explicit id, else the most recently updated one that
    // has both media and a timeline.
    QString pid = projectId;
    if (pid.isEmpty()) {
        QSqlQuery q(db);
        q.exec("SELECT p.id FROM projects p "
               "WHERE p.deleted_at IS NULL "
               "AND EXISTS (SELECT 1 FROM media_assets m WHERE m.project_id=p.id) "
               "AND EXISTS (SELECT 1 FROM timelines t WHERE t.project_id=p.id) "
               "ORDER BY p.updated_at DESC LIMIT 1");
        if (q.next()) {
            pid = q.value(0).toString();
        }
    }
    if (pid.isEmpty()) {
        db.close();
        return out;
    }
    out.id = pid;

    {
        QSqlQuery q(db);
        q.prepare("SELECT name FROM projects WHERE id=?");
        q.addBindValue(pid);
        if (q.exec() && q.next()) {
            out.name = q.value(0).toString();
        }
    }

    // Media assets (+ proxy resolution) and the media JSON for the UI.
    QJsonObject mediaJson;
    {
        QSqlQuery q(db);
        q.prepare("SELECT id, original_filename, local_path, duration_seconds, width, height "
                  "FROM media_assets WHERE project_id=?");
        q.addBindValue(pid);
        if (q.exec()) {
            while (q.next()) {
                MediaInfo mi;
                mi.id = q.value(0).toString();
                mi.filename = q.value(1).toString();
                mi.path = resolvePlayablePath(pid, mi.id, q.value(2).toString());
                mi.duration = q.value(3).toDouble();
                mi.width = q.value(4).toInt();
                mi.height = q.value(5).toInt();
                out.media.insert(mi.id, mi);

                QJsonObject mj;
                mj["original_filename"] = mi.filename;
                mj["duration_seconds"] = mi.duration;
                mj["width"] = mi.width;
                mj["height"] = mi.height;
                mj["type"] = "video";
                mj["size_bytes"] = QFileInfo(mi.path).size();
                mj["category"] = QJsonValue::Null;
                mj["tags"] = QJsonArray();
                mediaJson[mi.id] = mj;
            }
        }
    }
    out.mediaJson = QString::fromUtf8(QJsonDocument(mediaJson).toJson(QJsonDocument::Compact));

    // Latest timeline JSON.
    QString dataJson;
    {
        QSqlQuery q(db);
        q.prepare("SELECT data_json FROM timelines WHERE project_id=? ORDER BY version DESC LIMIT 1");
        q.addBindValue(pid);
        if (q.exec() && q.next()) {
            dataJson = q.value(0).toString();
        }
    }
    db.close();

    if (dataJson.isEmpty()) {
        return out;
    }
    out.rawTimelineJson = dataJson;

    const QJsonObject root = QJsonDocument::fromJson(dataJson.toUtf8()).object();
    out.duration = numberOr(root, "duration", 0.0);
    const QJsonObject canvas = root.value("canvas").toObject();
    out.canvasW = static_cast<int>(numberOr(canvas, "width", 1920));
    out.canvasH = static_cast<int>(numberOr(canvas, "height", 1080));
    out.fps = numberOr(canvas, "fps", 30.0);

    for (const QJsonValue &tv : root.value("tracks").toArray()) {
        const QJsonObject to = tv.toObject();
        TrackInfo track;
        track.id = to.value("id").toString();
        track.kind = to.value("kind").toString();
        track.name = to.value("name").toString();
        track.order = static_cast<int>(numberOr(to, "order", 0));
        track.hidden = to.value("hidden").toBool(false);
        track.locked = to.value("locked").toBool(false);

        for (const QJsonValue &ev : to.value("elements").toArray()) {
            const QJsonObject eo = ev.toObject();
            ClipInfo clip;
            clip.id = eo.value("id").toString();
            clip.kind = eo.value("type").toString();
            clip.mediaId = eo.value("media_id").toString();
            clip.sourceStart = numberOr(eo, "source_start", 0.0);
            clip.sourceEnd = numberOr(eo, "source_end", 0.0);
            clip.timelineStart = numberOr(eo, "timeline_start", 0.0);
            clip.timelineEnd = numberOr(eo, "timeline_end", 0.0);
            clip.text = eo.value("text").toString();
            clip.opacity = numberOr(eo, "opacity", 1.0);
            clip.fadeIn = numberOr(eo, "fadeIn", 0.0);
            clip.fadeOut = numberOr(eo, "fadeOut", 0.0);
            clip.volume = numberOr(eo, "volume", 1.0);
            clip.audioFadeIn = numberOr(eo, "audioFadeIn", 0.0);
            clip.audioFadeOut = numberOr(eo, "audioFadeOut", 0.0);
            clip.flipH = eo.value("flipH").toBool(false);
            clip.flipV = eo.value("flipV").toBool(false);

            const QJsonObject color = eo.value("color").toObject();
            clip.brightness = numberOr(color, "brightness", 1.0);
            clip.contrast = numberOr(color, "contrast", 1.0);
            clip.saturation = numberOr(color, "saturation", 1.0);

            const QJsonObject transform = eo.value("transform").toObject();
            clip.scale = numberOr(transform, "scale", 1.0);
            clip.x = numberOr(transform, "x", 0.0);
            clip.y = numberOr(transform, "y", 0.0);
            clip.rotation = numberOr(transform, "rotation", 0.0);

            if (hasObject(eo, "crop")) {
                const QJsonObject crop = eo.value("crop").toObject();
                clip.hasCrop = true;
                clip.cropX = numberOr(crop, "x", 0.0);
                clip.cropY = numberOr(crop, "y", 0.0);
                clip.cropW = numberOr(crop, "w", 1.0);
                clip.cropH = numberOr(crop, "h", 1.0);
            }

            if (hasObject(eo, "mask")) {
                const QJsonObject mask = eo.value("mask").toObject();
                clip.hasMask = true;
                clip.maskX = numberOr(mask, "x", 0.0);
                clip.maskY = numberOr(mask, "y", 0.0);
                clip.maskW = numberOr(mask, "w", 1.0);
                clip.maskH = numberOr(mask, "h", 1.0);
            }

            const QJsonObject chroma = eo.value("chroma").toObject();
            clip.chromaEnabled = chroma.value("enabled").toBool(false);
            clip.chromaColor = chroma.value("color").toString("#00ff00");
            clip.chromaSimilarity = numberOr(chroma, "similarity", 0.4);
            clip.chromaSmoothness = numberOr(chroma, "smoothness", 0.12);
            track.clips.append(clip);
        }
        out.tracks.append(track);
    }

    out.valid = !out.tracks.isEmpty() || !out.media.isEmpty();
    return out;
}

bool saveProjectTimeline(const QString &dbPath, const QString &projectId,
                         const QString &timelineJson, QString *error)
{
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(timelineJson.toUtf8(), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
        if (error) {
            *error = QString("Invalid timeline JSON: %1").arg(err.errorString());
        }
        return false;
    }

    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(dbPath);
    if (!db.open()) {
        if (error) {
            *error = db.lastError().text();
        }
        return false;
    }

    int latestVersion = 0;
    QString latestId;
    {
        QSqlQuery q(db);
        q.prepare("SELECT id, version FROM timelines WHERE project_id=? ORDER BY version DESC LIMIT 1");
        q.addBindValue(projectId);
        if (q.exec() && q.next()) {
            latestId = q.value(0).toString();
            latestVersion = q.value(1).toInt();
        }
    }

    bool ok = false;
    if (!latestId.isEmpty()) {
        QSqlQuery q(db);
        q.prepare("UPDATE timelines SET data_json=? WHERE id=?");
        q.addBindValue(QString::fromUtf8(doc.toJson(QJsonDocument::Compact)));
        q.addBindValue(latestId);
        ok = q.exec();
        if (!ok && error) {
            *error = q.lastError().text();
        }
    } else {
        QSqlQuery q(db);
        q.prepare("INSERT INTO timelines (id, project_id, version, data_json, created_at) "
                  "VALUES (?, ?, ?, ?, datetime('now'))");
        q.addBindValue(QUuid::createUuid().toString(QUuid::WithoutBraces).remove('-'));
        q.addBindValue(projectId);
        q.addBindValue(latestVersion + 1);
        q.addBindValue(QString::fromUtf8(doc.toJson(QJsonDocument::Compact)));
        ok = q.exec();
        if (!ok && error) {
            *error = q.lastError().text();
        }
    }

    if (ok) {
        QSqlQuery q(db);
        q.prepare("UPDATE projects SET updated_at=datetime('now') WHERE id=?");
        q.addBindValue(projectId);
        q.exec();
    }

    db.close();
    return ok;
}
