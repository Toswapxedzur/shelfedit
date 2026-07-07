#include "MainWindow.h"

#include "Bridge.h"
#include "MltController.h"
#include "VideoWidget.h"

#include <cstdio>

#include <QUrl>
#include <QVBoxLayout>
#include <QWebChannel>
#include <QWebEnginePage>
#include <QWebEngineView>
#include <QWidget>

namespace {
// Forward JavaScript console output to stderr so the HTML UI is debuggable
// from the terminal during development.
class LoggingPage : public QWebEnginePage
{
public:
    using QWebEnginePage::QWebEnginePage;

protected:
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString &message,
                                  int lineNumber, const QString &sourceId) override
    {
        std::fprintf(stderr, "[js:%d] %s (%s:%d)\n", static_cast<int>(level),
                     message.toUtf8().constData(), sourceId.toUtf8().constData(), lineNumber);
    }
};
} // namespace

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent)
{
    setWindowTitle("ShelfEdit");
    resize(1200, 820);

    m_controller = new MltController(this);
    m_video = new VideoWidget(this);
    m_bridge = new Bridge(m_controller, this);

    m_webView = new QWebEngineView(this);
    m_webView->setPage(new LoggingPage(m_webView));

    m_channel = new QWebChannel(this);
    m_channel->registerObject(QStringLiteral("bridge"), m_bridge);
    m_webView->page()->setWebChannel(m_channel);

    // Frames arrive on the consumer thread; queued connection marshals to GUI.
    connect(m_controller, &MltController::frameReady,
            m_video, &VideoWidget::setImage, Qt::QueuedConnection);

    auto *central = new QWidget(this);
    auto *layout = new QVBoxLayout(central);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);
    layout->addWidget(m_video, 3);
    layout->addWidget(m_webView, 1);
    setCentralWidget(central);

    const QString index = QString::fromUtf8(APP_WEB_DIR) + "/index.html";
    m_webView->load(QUrl::fromLocalFile(index));
}

bool MainWindow::load(const QString &path)
{
    if (path.isEmpty() || !m_controller->open(path)) {
        return false;
    }
    setWindowTitle(QString("ShelfEdit — %1").arg(path.section('/', -1)));
    return true;
}

bool MainWindow::loadProject(const ProjectData &project)
{
    if (!project.valid || !m_controller->openProject(project)) {
        return false;
    }
    m_bridge->setProject(project);
    setWindowTitle(QString("ShelfEdit — %1").arg(project.name));
    return true;
}
