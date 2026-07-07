#include "Bridge.h"

#include "Log.h"
#include "MltController.h"

#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>
#include <QVariant>

#include <mlt++/Mlt.h>

namespace {

QString newHexId()
{
    return QUuid::createUuid().toString(QUuid::WithoutBraces).remove('-');
}

QString projectRoot(const QString &projectId)
{
    return QDir::homePath() + "/.local_ai_video_editor/projects/" + projectId;
}

struct ProbeInfo
{
    double duration = 0.0;
    int width = 0;
    int height = 0;
};

ProbeInfo probeMedia(const QString &path)
{
    ProbeInfo info;
    Mlt::Profile profile;
    Mlt::Producer first(profile, "loader", path.toUtf8().constData());
    if (!first.is_valid()) {
        return info;
    }
    profile.from_producer(first);
    Mlt::Producer producer(profile, "loader", path.toUtf8().constData());
    const double fps = profile.fps() > 0 ? profile.fps() : 30.0;
    const int len = (producer.is_valid() ? producer : first).get_length();
    info.duration = len > 0 ? len / fps : 0.0;
    info.width = profile.width();
    info.height = profile.height();
    return info;
}

QString defaultTimelineJson()
{
    QJsonObject root;
    root["duration"] = 0;
    root["canvas"] = QJsonObject{{"width", 1280}, {"height", 720}, {"fps", 30}};
    root["tracks"] = QJsonArray{
        QJsonObject{{"id", "trk_text_1"}, {"kind", "text"}, {"name", "Text"}, {"order", 0}, {"elements", QJsonArray()}},
        QJsonObject{{"id", "trk_video_1"}, {"kind", "video"}, {"name", "Video"}, {"order", 1}, {"elements", QJsonArray()}},
        QJsonObject{{"id", "trk_audio_1"}, {"kind", "audio"}, {"name", "Audio"}, {"order", 2}, {"elements", QJsonArray()}},
    };
    return QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact));
}

} // namespace

Bridge::Bridge(MltController *controller, QObject *parent)
    : QObject(parent)
    , m_controller(controller)
{
    connect(m_controller, &MltController::opened, this, [this](double duration, double fps) {
        m_duration = duration;
        m_fps = fps;
        emit opened(duration, fps);
    });
    connect(m_controller, &MltController::positionChanged, this,
            [this](int /*frame*/, double seconds) {
                m_position = seconds;
                emit positionChanged(seconds, m_duration);
            });
    connect(m_controller, &MltController::playingChanged, this, [this](bool playing) {
        m_playing = playing;
        emit playingChanged(playing);
    });
}

void Bridge::setProject(const ProjectData &project)
{
    m_projectId = project.id;
    m_timelineJson = project.rawTimelineJson;
    m_mediaJson = project.mediaJson;
    m_projectName = project.name;
    emit projectLoaded(m_timelineJson, m_mediaJson, m_projectName);
}

QString Bridge::listProjects()
{
    QJsonArray arr;
    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(defaultDbPath());
    if (!db.open()) {
        return "[]";
    }

    QSqlQuery q(db);
    q.exec("SELECT p.id, p.name, p.updated_at, p.status, "
           "(SELECT COUNT(*) FROM media_assets m WHERE m.project_id=p.id AND m.type!='export') AS media_count "
           "FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC");
    while (q.next()) {
        QJsonObject p;
        p["id"] = q.value(0).toString();
        p["name"] = q.value(1).toString();
        p["updated_at"] = q.value(2).toString();
        p["status"] = q.value(3).toString();
        p["media_count"] = q.value(4).toInt();
        arr.append(p);
    }
    db.close();
    return QString::fromUtf8(QJsonDocument(arr).toJson(QJsonDocument::Compact));
}

bool Bridge::openProjectById(const QString &projectId)
{
    ProjectData project = loadProject(defaultDbPath(), projectId);
    if (!project.valid) {
        appLog(QString("[BRIDGE] openProjectById failed id=%1").arg(projectId));
        return false;
    }
    if (!m_controller->openProject(project)) {
        appLog(QString("[BRIDGE] openProjectById graph failed id=%1").arg(projectId));
        return false;
    }
    setProject(project);
    return true;
}

QString Bridge::createProject(const QString &name)
{
    const QString trimmed = name.trimmed();
    if (trimmed.isEmpty()) {
        return QString();
    }
    const QString id = newHexId();
    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(defaultDbPath());
    if (!db.open()) {
        return QString();
    }

    QSqlQuery p(db);
    p.prepare("INSERT INTO projects (id, name, created_at, updated_at, status, storage_mode) "
              "VALUES (?, ?, datetime('now'), datetime('now'), 'empty', 'local_only')");
    p.addBindValue(id);
    p.addBindValue(trimmed);
    if (!p.exec()) {
        appLog(QString("[BRIDGE] createProject failed: %1").arg(p.lastError().text()));
        db.close();
        return QString();
    }

    QSqlQuery t(db);
    t.prepare("INSERT INTO timelines (id, project_id, version, data_json, created_at) "
              "VALUES (?, ?, 1, ?, datetime('now'))");
    t.addBindValue(newHexId());
    t.addBindValue(id);
    t.addBindValue(defaultTimelineJson());
    t.exec();
    db.close();

    openProjectById(id);
    return id;
}

QString Bridge::transcriptJson()
{
    if (m_projectId.isEmpty()) {
        return "{\"segments\":[]}";
    }
    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(defaultDbPath());
    if (!db.open()) {
        return "{\"segments\":[]}";
    }

    QString transcriptId;
    {
        QSqlQuery q(db);
        q.prepare("SELECT id FROM transcripts WHERE project_id=? ORDER BY created_at DESC LIMIT 1");
        q.addBindValue(m_projectId);
        if (q.exec() && q.next()) {
            transcriptId = q.value(0).toString();
        }
    }

    QJsonArray segments;
    if (!transcriptId.isEmpty()) {
        QSqlQuery q(db);
        q.prepare("SELECT idx, start_seconds, end_seconds, text FROM transcript_segments "
                  "WHERE transcript_id=? ORDER BY idx");
        q.addBindValue(transcriptId);
        if (q.exec()) {
            while (q.next()) {
                QJsonObject s;
                s["idx"] = q.value(0).toInt();
                s["start_seconds"] = q.value(1).toDouble();
                s["end_seconds"] = q.value(2).toDouble();
                s["text"] = q.value(3).toString();
                segments.append(s);
            }
        }
    }
    db.close();

    QJsonObject out;
    out["segments"] = segments;
    return QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact));
}

bool Bridge::saveTimeline(const QString &timelineJson)
{
    if (m_projectId.isEmpty()) {
        appLog("[BRIDGE] saveTimeline failed: no active project id");
        return false;
    }

    QString error;
    if (!saveProjectTimeline(defaultDbPath(), m_projectId, timelineJson, &error)) {
        appLog(QString("[BRIDGE] saveTimeline failed: %1").arg(error));
        return false;
    }

    ProjectData updated = loadProject(defaultDbPath(), m_projectId);
    if (!updated.valid) {
        appLog("[BRIDGE] saveTimeline saved but reload failed");
        return false;
    }

    if (!m_controller->openProject(updated)) {
        appLog("[BRIDGE] saveTimeline saved but MLT graph rebuild failed");
        return false;
    }

    setProject(updated);
    appLog(QString("[BRIDGE] saveTimeline ok project=%1").arg(m_projectId));
    return true;
}

QString Bridge::pickVideoFile()
{
    return QFileDialog::getOpenFileName(nullptr, tr("Import media"), QDir::homePath(),
                                        tr("Video files (*.mov *.mp4 *.m4v *.mkv *.avi);;All files (*)"));
}

QString Bridge::importMedia(const QString &path, bool copyIntoProject)
{
    if (m_projectId.isEmpty()) {
        appLog("[BRIDGE] importMedia failed: no active project id");
        return QString();
    }
    const QFileInfo src(path);
    if (!src.exists() || !src.isFile()) {
        appLog(QString("[BRIDGE] importMedia failed: missing file %1").arg(path));
        return QString();
    }

    const QString mediaId = newHexId();
    QString localPath = src.absoluteFilePath();
    QString relativePath;
    if (copyIntoProject) {
        const QString dirPath = projectRoot(m_projectId) + "/media/original";
        QDir().mkpath(dirPath);
        const QString dest = dirPath + "/" + mediaId + "_" + src.fileName();
        if (!QFile::copy(src.absoluteFilePath(), dest)) {
            appLog(QString("[BRIDGE] importMedia failed: copy %1 -> %2").arg(src.absoluteFilePath(), dest));
            return QString();
        }
        localPath = dest;
        relativePath = "media/original/" + QFileInfo(dest).fileName();
    }

    const ProbeInfo probe = probeMedia(localPath);

    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(defaultDbPath());
    if (!db.open()) {
        appLog(QString("[BRIDGE] importMedia failed: %1").arg(db.lastError().text()));
        return QString();
    }

    QSqlQuery q(db);
    q.prepare("INSERT INTO media_assets "
              "(id, project_id, type, storage_kind, original_filename, local_path, relative_path, "
              "duration_seconds, width, height, size_bytes, created_at) "
              "VALUES (?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))");
    q.addBindValue(mediaId);
    q.addBindValue(m_projectId);
    q.addBindValue(copyIntoProject ? "copied" : "referenced");
    q.addBindValue(src.fileName());
    q.addBindValue(localPath);
    q.addBindValue(relativePath.isEmpty() ? QVariant() : QVariant(relativePath));
    q.addBindValue(probe.duration);
    q.addBindValue(probe.width);
    q.addBindValue(probe.height);
    q.addBindValue(src.size());
    if (!q.exec()) {
        appLog(QString("[BRIDGE] importMedia failed: %1").arg(q.lastError().text()));
        db.close();
        return QString();
    }

    QSqlQuery up(db);
    up.prepare("UPDATE projects SET status='imported', updated_at=datetime('now') WHERE id=?");
    up.addBindValue(m_projectId);
    up.exec();
    db.close();

    ProjectData updated = loadProject(defaultDbPath(), m_projectId);
    if (updated.valid) {
        setProject(updated);
    }
    appLog(QString("[BRIDGE] importMedia ok id=%1 path=%2").arg(mediaId, localPath));
    return mediaId;
}

QString Bridge::pickExportPath(const QString &suggestedName)
{
    QString name = suggestedName.trimmed();
    if (name.isEmpty()) {
        name = m_projectName.isEmpty() ? "export.mp4" : m_projectName + ".mp4";
    }
    if (!name.endsWith(".mp4", Qt::CaseInsensitive)) {
        name += ".mp4";
    }
    return QFileDialog::getSaveFileName(nullptr, tr("Export video"),
                                        QDir::homePath() + "/" + name,
                                        tr("MP4 video (*.mp4);;All files (*)"));
}

bool Bridge::exportCurrent(const QString &path)
{
    if (m_projectId.isEmpty() || path.isEmpty()) {
        return false;
    }
    appLog(QString("[BRIDGE] export start %1").arg(path));
    if (!m_controller->exportToFile(path)) {
        appLog("[BRIDGE] export failed in MLT");
        return false;
    }

    const QFileInfo out(path);
    const ProbeInfo probe = probeMedia(path);
    QSqlDatabase db = QSqlDatabase::database("shelfedit", false);
    if (!db.isValid()) {
        db = QSqlDatabase::addDatabase("QSQLITE", "shelfedit");
    }
    db.setDatabaseName(defaultDbPath());
    if (db.open()) {
        QSqlQuery q(db);
        q.prepare("INSERT INTO media_assets "
                  "(id, project_id, type, storage_kind, original_filename, local_path, relative_path, "
                  "duration_seconds, width, height, size_bytes, created_at) "
                  "VALUES (?, ?, 'export', 'copied', ?, ?, NULL, ?, ?, ?, ?, datetime('now'))");
        q.addBindValue(newHexId());
        q.addBindValue(m_projectId);
        q.addBindValue(out.fileName());
        q.addBindValue(out.absoluteFilePath());
        q.addBindValue(probe.duration);
        q.addBindValue(probe.width);
        q.addBindValue(probe.height);
        q.addBindValue(out.size());
        q.exec();

        QSqlQuery up(db);
        up.prepare("UPDATE projects SET status='rendered', updated_at=datetime('now') WHERE id=?");
        up.addBindValue(m_projectId);
        up.exec();
        db.close();
    }
    appLog(QString("[BRIDGE] export ok %1").arg(path));
    return true;
}

void Bridge::log(const QString &message)
{
    appLog(message);
}

void Bridge::play()
{
    m_controller->play();
}

void Bridge::pause()
{
    m_controller->pause();
}

void Bridge::togglePlay()
{
    m_controller->togglePlay();
}

void Bridge::seek(double seconds)
{
    m_controller->seekSeconds(seconds);
}
