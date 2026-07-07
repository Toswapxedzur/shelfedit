#pragma once

#include <QObject>
#include <QString>

#include "Timeline.h"

class MltController;

// The JS <-> C++ boundary, exposed over QWebChannel. The HTML UI calls the
// public slots to drive MLT, and connects to the signals for state. Crucially,
// NO video frames cross this bridge: frames go MLT -> native preview widget.
// Only commands, timeline data, and lightweight state travel here.
class Bridge : public QObject
{
    Q_OBJECT
public:
    explicit Bridge(MltController *controller, QObject *parent = nullptr);

    // Populated by C++ after a project loads; the page pulls these on connect.
    void setProject(const ProjectData &project);

    // Initial-state pull for JS once the channel connects.
    Q_INVOKABLE double durationSeconds() const { return m_duration; }
    Q_INVOKABLE double fps() const { return m_fps; }
    Q_INVOKABLE double positionSeconds() const { return m_position; }
    Q_INVOKABLE bool playing() const { return m_playing; }
    Q_INVOKABLE QString timelineJson() const { return m_timelineJson; }
    Q_INVOKABLE QString mediaJson() const { return m_mediaJson; }
    Q_INVOKABLE QString projectName() const { return m_projectName; }
    Q_INVOKABLE QString projectId() const { return m_projectId; }
    Q_INVOKABLE QString listProjects();
    Q_INVOKABLE bool openProjectById(const QString &projectId);
    Q_INVOKABLE QString createProject(const QString &name);
    Q_INVOKABLE QString transcriptJson();
    Q_INVOKABLE bool saveTimeline(const QString &timelineJson);
    Q_INVOKABLE QString pickVideoFile();
    Q_INVOKABLE QString importMedia(const QString &path, bool copyIntoProject);
    Q_INVOKABLE QString pickExportPath(const QString &suggestedName);
    Q_INVOKABLE bool exportCurrent(const QString &path);
    // JS routes all diagnostic logging here so it lands in /tmp/shelfedit.log
    // with a guaranteed flush.
    Q_INVOKABLE void log(const QString &message);

public slots:
    void play();
    void pause();
    void togglePlay();
    void seek(double seconds);

signals:
    void opened(double durationSeconds, double fps);
    void positionChanged(double seconds, double durationSeconds);
    void playingChanged(bool playing);
    void projectLoaded(const QString &timelineJson, const QString &mediaJson, const QString &name);

private:
    MltController *m_controller;
    double m_duration = 0.0;
    double m_fps = 0.0;
    double m_position = 0.0;
    bool m_playing = false;
    QString m_projectId;
    QString m_timelineJson;
    QString m_mediaJson;
    QString m_projectName;
};
