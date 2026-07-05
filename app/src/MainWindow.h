#pragma once

#include <QMainWindow>
#include <QString>

class VideoWidget;
class MltController;
class Bridge;
class QWebEngineView;
class QWebChannel;

// Slice 2 shell: the native preview surface (fed by MLT) on top, and the HTML
// UI (transport now, full timeline later) hosted in a QWebEngineView below,
// talking to C++/MLT over a QWebChannel bridge.
class MainWindow : public QMainWindow
{
    Q_OBJECT
public:
    explicit MainWindow(QWidget *parent = nullptr);

    bool load(const QString &path);

private:
    VideoWidget *m_video = nullptr;
    MltController *m_controller = nullptr;
    Bridge *m_bridge = nullptr;
    QWebEngineView *m_webView = nullptr;
    QWebChannel *m_channel = nullptr;
};
