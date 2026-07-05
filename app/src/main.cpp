#include <QApplication>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QStandardPaths>
#include <QTimer>

#include <cstdio>

#include <mlt++/Mlt.h>

#include "MainWindow.h"
#include "MltController.h"

namespace {

// Slice 1 convenience: if no path is given, find the newest video file in the
// legacy data folder or on the Desktop so there is something to play.
QString findDefaultVideo()
{
    const QStringList exts = {"*.mov", "*.mp4", "*.m4v", "*.mkv", "*.avi"};
    QStringList roots;
    roots << QDir::homePath() + "/.local_ai_video_editor/projects";
    roots << QStandardPaths::writableLocation(QStandardPaths::DesktopLocation);
    roots << QStandardPaths::writableLocation(QStandardPaths::MoviesLocation);

    QString best;
    QDateTime bestTime;
    for (const QString &root : roots) {
        if (!QDir(root).exists()) {
            continue;
        }
        QDirIterator it(root, exts, QDir::Files, QDirIterator::Subdirectories);
        while (it.hasNext()) {
            const QString file = it.next();
            const QDateTime mtime = QFileInfo(file).lastModified();
            if (best.isEmpty() || mtime > bestTime) {
                best = file;
                bestTime = mtime;
            }
        }
    }
    return best;
}

// Headless proof: play for ~2.5s, count frames pushed through the frame-show
// path, save one to PNG. Verifies the engine without needing a visible window.
int runSelfTest(const QString &path)
{
    MltController controller;
    int frames = 0;
    QImage lastImage;
    QElapsedTimer timer;

    QObject::connect(&controller, &MltController::frameReady,
                     [&](const QImage &image) {
                         ++frames;
                         lastImage = image;
                     });

    if (!controller.open(path)) {
        std::fprintf(stderr, "selftest: failed to open %s\n", path.toUtf8().constData());
        return 2;
    }
    std::fprintf(stderr, "selftest: opened %s  %.3fs @ %.2ffps  preview frames incoming...\n",
                 path.toUtf8().constData(), controller.durationSeconds(), controller.fps());

    timer.start();
    controller.play();

    QTimer::singleShot(2500, [&] {
        controller.pause();
        const double secs = timer.elapsed() / 1000.0;
        std::fprintf(stderr, "selftest: %d frames in %.2fs = %.1f fps\n",
                     frames, secs, secs > 0 ? frames / secs : 0.0);
        if (!lastImage.isNull()) {
            const int w = lastImage.width();
            const int h = lastImage.height();
            auto dump = [&](int x, int y) {
                const QColor c = lastImage.pixelColor(x, y);
                std::fprintf(stderr, "  px(%d,%d) rgba=%d,%d,%d,%d\n",
                             x, y, c.red(), c.green(), c.blue(), c.alpha());
            };
            dump(w / 4, h / 4);
            dump(w / 2, h / 2);
            dump(w / 2, h * 3 / 4);
            lastImage.save("/tmp/shelf_selftest.png");
            lastImage.convertToFormat(QImage::Format_RGB888).save("/tmp/shelf_selftest.jpg");
            std::fprintf(stderr, "selftest: saved %dx%d frame (png+jpg)\n", w, h);
        }
        QCoreApplication::quit();
    });

    return QCoreApplication::exec();
}

} // namespace

int main(int argc, char **argv)
{
    QApplication app(argc, argv);

    Mlt::Factory::init();

    int rc = 0;
    if (argc > 1 && QString::fromUtf8(argv[1]) == "--selftest") {
        const QString path = (argc > 2) ? QString::fromUtf8(argv[2]) : findDefaultVideo();
        rc = runSelfTest(path);
    } else {
        auto *window = new MainWindow();
        const QString path = (argc > 1) ? QString::fromUtf8(argv[1]) : findDefaultVideo();
        window->load(path);
        window->show();
        rc = app.exec();
        delete window;
    }

    Mlt::Factory::close();
    return rc;
}
