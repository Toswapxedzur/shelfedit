#pragma once

#include <QObject>

class MltController;

// The JS <-> C++ boundary, exposed over QWebChannel. The HTML UI calls the
// public slots to drive MLT, and connects to the signals for state. Crucially,
// NO video frames cross this bridge: frames go MLT -> native preview widget.
// Only commands and lightweight state travel here.
//
// State is cached so the page can sync on load (signals may fire before the
// web view's JS has connected to the channel).
class Bridge : public QObject
{
    Q_OBJECT
public:
    explicit Bridge(MltController *controller, QObject *parent = nullptr);

    // Initial-state pull for JS once the channel connects.
    Q_INVOKABLE double durationSeconds() const { return m_duration; }
    Q_INVOKABLE double fps() const { return m_fps; }
    Q_INVOKABLE double positionSeconds() const { return m_position; }
    Q_INVOKABLE bool playing() const { return m_playing; }

public slots:
    void play();
    void pause();
    void togglePlay();
    void seek(double seconds);

signals:
    void opened(double durationSeconds, double fps);
    void positionChanged(double seconds, double durationSeconds);
    void playingChanged(bool playing);

private:
    MltController *m_controller;
    double m_duration = 0.0;
    double m_fps = 0.0;
    double m_position = 0.0;
    bool m_playing = false;
};
