#pragma once

#include <QMainWindow>
#include <QString>

class VideoWidget;
class MltController;
class QPushButton;
class QSlider;
class QLabel;

// Slice 1 shell: a native Qt window with the preview surface on top and a
// transport row (play/pause, scrub slider, time readout) below. Slice 2
// replaces the transport/timeline area with a QWebEngineView hosting the UI.
class MainWindow : public QMainWindow
{
    Q_OBJECT
public:
    explicit MainWindow(QWidget *parent = nullptr);

    bool load(const QString &path);

private slots:
    void onOpened(double durationSeconds, double fps);
    void onPositionChanged(int frame, double seconds);
    void onPlayingChanged(bool playing);
    void onSliderMoved(int value);

private:
    VideoWidget *m_video = nullptr;
    MltController *m_controller = nullptr;
    QPushButton *m_playButton = nullptr;
    QSlider *m_slider = nullptr;
    QLabel *m_timeLabel = nullptr;

    double m_duration = 0.0;
    bool m_userScrubbing = false;
};
