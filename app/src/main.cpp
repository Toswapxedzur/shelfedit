#include <QApplication>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <QTimer>

#include <cstdio>

#include <mlt++/Mlt.h>

#include "MainWindow.h"
#include "MltController.h"
#include "Timeline.h"

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

// Wrap a single media file in a minimal one-clip timeline (video + audio track)
// so the full tractor + HTML timeline/scrub UI work for any file — handy for
// stress-testing playback/scrub against arbitrary footage.
ProjectData makeSingleClipProject(const QString &path)
{
    ProjectData p;
    if (!QFileInfo::exists(path)) {
        return p;
    }

    Mlt::Profile profile;
    Mlt::Producer probe(profile, "loader", path.toUtf8().constData());
    if (!probe.is_valid()) {
        return p;
    }
    // Adopt the file's real resolution / frame rate / aspect into the profile
    // (meta.media.* isn't reliably populated; from_producer is what the
    // single-file open() path uses).
    profile.from_producer(probe);
    double fps = profile.fps();
    if (fps <= 0.0) {
        fps = 30.0;
    }
    // Re-create the producer against the corrected profile so its length is
    // measured at the real frame rate (the first producer cached its length
    // against MLT's default 25fps profile, which mis-reports the duration).
    Mlt::Producer real(profile, "loader", path.toUtf8().constData());
    const int len = (real.is_valid() ? real : probe).get_length();
    const double dur = len / fps;
    int w = profile.width();
    int h = profile.height();
    if (w <= 0 || h <= 0) {
        w = 1920;
        h = 1080;
    }

    const QFileInfo fi(path);
    const QString mediaId = "m0";

    MediaInfo mi;
    mi.id = mediaId;
    mi.path = path;
    mi.filename = fi.fileName();
    mi.duration = dur;
    mi.width = w;
    mi.height = h;
    p.media.insert(mediaId, mi);

    const auto makeClip = [&](const QString &id, const QString &kind) {
        ClipInfo c;
        c.id = id;
        c.kind = kind;
        c.mediaId = mediaId;
        c.sourceStart = 0.0;
        c.sourceEnd = dur;
        c.timelineStart = 0.0;
        return c;
    };

    TrackInfo vt;
    vt.id = "trk_v";
    vt.kind = "video";
    vt.name = "Video";
    vt.order = 0;
    vt.clips.append(makeClip("clip_v", "video"));

    TrackInfo at;
    at.id = "trk_a";
    at.kind = "audio";
    at.name = "Audio";
    at.order = 1;
    at.clips.append(makeClip("clip_a", "audio"));

    p.tracks.append(vt);
    p.tracks.append(at);
    p.duration = dur;
    p.canvasW = w;
    p.canvasH = h;
    p.fps = fps;
    p.name = fi.fileName();
    p.id = "single";

    // Build the JSON payloads the HTML UI consumes (same shape as the DB path).
    const auto clipJson = [&](const QString &id, const QString &type) {
        QJsonObject c;
        c["id"] = id;
        c["type"] = type;
        c["media_id"] = mediaId;
        c["source_start"] = 0.0;
        c["source_end"] = dur;
        c["timeline_start"] = 0.0;
        return c;
    };
    QJsonObject canvas;
    canvas["width"] = w;
    canvas["height"] = h;
    canvas["fps"] = fps;
    QJsonObject vTrack{{"id", "trk_v"}, {"kind", "video"}, {"name", "Video"}, {"order", 0},
                       {"elements", QJsonArray{clipJson("clip_v", "video")}}};
    QJsonObject aTrack{{"id", "trk_a"}, {"kind", "audio"}, {"name", "Audio"}, {"order", 1},
                       {"elements", QJsonArray{clipJson("clip_a", "audio")}}};
    QJsonObject root;
    root["duration"] = dur;
    root["canvas"] = canvas;
    root["tracks"] = QJsonArray{vTrack, aTrack};
    p.rawTimelineJson = QString::fromUtf8(QJsonDocument(root).toJson(QJsonDocument::Compact));

    QJsonObject mediaMeta;
    mediaMeta["original_filename"] = mi.filename;
    mediaMeta["duration_seconds"] = dur;
    mediaMeta["width"] = w;
    mediaMeta["height"] = h;
    QJsonObject mediaObj;
    mediaObj[mediaId] = mediaMeta;
    p.mediaJson = QString::fromUtf8(QJsonDocument(mediaObj).toJson(QJsonDocument::Compact));

    p.valid = true;
    return p;
}

// Headless proof: play for ~2.5s, count frames pushed through the frame-show
// path, save one to PNG. Verifies the engine without needing a visible window.
int measurePlayback(MltController &controller, const char *label)
{
    int frames = 0;
    QImage lastImage;
    QElapsedTimer timer;

    QObject::connect(&controller, &MltController::frameReady, [&](const QImage &image) {
        ++frames;
        lastImage = image;
    });

    std::fprintf(stderr, "selftest[%s]: %.3fs @ %.2ffps, playing...\n", label,
                 controller.durationSeconds(), controller.fps());

    timer.start();
    controller.play();

    QTimer::singleShot(2500, [&] {
        controller.pause();
        const double secs = timer.elapsed() / 1000.0;
        std::fprintf(stderr, "selftest[%s]: %d frames in %.2fs = %.1f fps\n", label, frames, secs,
                     secs > 0 ? frames / secs : 0.0);
        if (!lastImage.isNull()) {
            lastImage.convertToFormat(QImage::Format_RGB888).save("/tmp/shelf_selftest.jpg");
            std::fprintf(stderr, "selftest[%s]: saved %dx%d frame\n", label, lastImage.width(),
                         lastImage.height());
        }
        QCoreApplication::quit();
    });

    return QCoreApplication::exec();
}

int runFileSelfTest(const QString &path)
{
    MltController controller;
    if (!controller.open(path)) {
        std::fprintf(stderr, "selftest: failed to open %s\n", path.toUtf8().constData());
        return 2;
    }
    return measurePlayback(controller, "file");
}

// Stress the scrub/seek path: fire a burst of seeks across the timeline and
// confirm a frame comes back near each target (this is the fragile part —
// rapid seeking while the audio consumer runs).
int runScrubTest()
{
    const ProjectData project = loadProject(defaultDbPath());
    if (!project.valid) {
        std::fprintf(stderr, "scrubtest: no valid project\n");
        return 2;
    }
    auto *controller = new MltController();
    if (!controller->openProject(project)) {
        std::fprintf(stderr, "scrubtest: failed to build tractor\n");
        return 2;
    }

    const double dur = controller->durationSeconds();
    const double fps = controller->fps();
    int lastFrame = -1;
    QObject::connect(controller, &MltController::positionChanged,
                     [&](int frame, double) { lastFrame = frame; });

    double totalMs = 0;
    int hits = 0;
    const int N = qEnvironmentVariableIsSet("SCRUB_N") ? qEnvironmentVariableIntValue("SCRUB_N") : 15;
    const bool sweep = qEnvironmentVariableIsSet("SCRUB_SWEEP");
    for (int i = 0; i < N; ++i) {
        const double frac = sweep ? (i / double(N)) : ((i % 2 == 0) ? (i / double(N)) : (1.0 - i / double(N)));
        const double target = frac * dur;
        const int want = static_cast<int>(target * fps + 0.5);
        lastFrame = -1;
        QElapsedTimer t;
        t.start();
        controller->seekSeconds(target);
        while (t.elapsed() < 800 && std::abs(lastFrame - want) > 2) {
            QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
        }
        const double ms = t.elapsed();
        const bool ok = std::abs(lastFrame - want) <= 2;
        if (ok) {
            ++hits;
            totalMs += ms;
        }
        std::fprintf(stderr, "scrubtest: seek->%d landed=%s frame=%d in %.0fms\n", want,
                     ok ? "yes" : "NO", lastFrame, ms);
    }
    std::fprintf(stderr, "scrubtest: %d/%d correct, avg %.0fms/seek -> %s\n", hits, N,
                 hits ? totalMs / hits : 0.0, hits >= N - 1 ? "PASS" : "SUSPECT");
    // Optional: hold the process open (idle) so an external profiler can attach
    // and attribute retained memory. Also reveals whether RSS drops when idle.
    if (int hold = qEnvironmentVariableIntValue("SCRUB_HOLD_SEC")) {
        std::fprintf(stderr, "scrubtest: holding %ds for profiling (pid=%lld)\n", hold,
                     (long long) QCoreApplication::applicationPid());
        QElapsedTimer h;
        h.start();
        while (h.elapsed() < hold * 1000) {
            QCoreApplication::processEvents(QEventLoop::AllEvents, 100);
        }
    }
    delete controller;
    return hits >= N - 1 ? 0 : 3;
}

int runProjectSelfTest()
{
    const ProjectData project = loadProject(defaultDbPath());
    if (!project.valid) {
        std::fprintf(stderr, "selftest: no valid project in %s\n",
                     defaultDbPath().toUtf8().constData());
        return 2;
    }
    std::fprintf(stderr, "selftest: project '%s' — %d tracks, %d media\n",
                 project.name.toUtf8().constData(), static_cast<int>(project.tracks.size()),
                 static_cast<int>(project.media.size()));
    MltController controller;
    if (!controller.openProject(project)) {
        std::fprintf(stderr, "selftest: failed to build tractor\n");
        return 2;
    }
    return measurePlayback(controller, "project");
}

} // namespace

int main(int argc, char **argv)
{
    // Required by QtWebEngine (must be set before the QApplication is created).
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QApplication app(argc, argv);

    Mlt::Factory::init();

    const QString arg1 = argc > 1 ? QString::fromUtf8(argv[1]) : QString();

    int rc = 0;
    if (arg1 == "--selftest") {
        const QString path = argc > 2 ? QString::fromUtf8(argv[2]) : findDefaultVideo();
        rc = runFileSelfTest(path);
    } else if (arg1 == "--selftest-project") {
        rc = runProjectSelfTest();
    } else if (arg1 == "--scrubtest") {
        rc = runScrubTest();
    } else {
        auto *window = new MainWindow();
        // If an explicit file path is given, open it as a one-clip project so the
        // scrub/timeline UI works with it. Otherwise use the DB project.
        ProjectData project;
        if (!arg1.isEmpty() && QFileInfo::exists(arg1)) {
            project = makeSingleClipProject(arg1);
        }
        if (!project.valid) {
            project = loadProject(defaultDbPath());
        }
        if (!(project.valid && window->loadProject(project))) {
            window->load(arg1.isEmpty() ? findDefaultVideo() : arg1);
        }
        window->show();
        rc = app.exec();
        delete window;
    }

    Mlt::Factory::close();
    return rc;
}
