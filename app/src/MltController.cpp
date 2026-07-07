#include "MltController.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include <QVector>

#include <mlt++/Mlt.h>

#include "Log.h"

namespace {
// Preview is rendered/scrubbed at 1080p (a 1920x1080 box, aspect preserved),
// not the source resolution.
constexpr int kMaxPreviewWidth = 1920;
constexpr int kMaxPreviewHeight = 1080;

bool nearly(double a, double b)
{
    return std::abs(a - b) < 0.0001;
}

QString rectForClip(const ClipInfo &clip, int w, int h)
{
    const double scale = std::max(0.05, clip.scale);
    const double rw = w * scale;
    const double rh = h * scale;
    const double x = (w - rw) / 2.0 + clip.x * w * 0.5;
    const double y = (h - rh) / 2.0 + clip.y * h * 0.5;
    const double opacityPct = std::max(0.0, std::min(1.0, clip.opacity)) * 100.0;
    return QString("%1/%2:%3x%4:%5")
        .arg(std::lround(x))
        .arg(std::lround(y))
        .arg(std::lround(rw))
        .arg(std::lround(rh))
        .arg(opacityPct, 0, 'f', 1);
}
}

MltController::MltController(QObject *parent)
    : QObject(parent)
{
}

MltController::~MltController()
{
    teardown();
}

void MltController::teardown()
{
    if (m_frameEvent) {
        m_frameEvent->block();
        Mlt::Properties::delete_event(m_frameEvent);
        m_frameEvent = nullptr;
    }
    if (m_consumer) {
        m_consumer->stop();
    }
    m_consumer.reset();
    m_transitions.clear();
    m_playlists.clear();
    m_filters.clear();
    m_clipProducers.clear();
    m_background.reset();
    m_root.reset();
    m_profile.reset();
}

void MltController::configurePreviewProfile(int sourceW, int sourceH)
{
    if (sourceW > 0 && sourceH > 0) {
        const double f = std::min({1.0,
                                   static_cast<double>(kMaxPreviewWidth) / sourceW,
                                   static_cast<double>(kMaxPreviewHeight) / sourceH});
        const int w = static_cast<int>(std::lround(sourceW * f)) & ~1;
        const int h = static_cast<int>(std::lround(sourceH * f)) & ~1;
        m_profile->set_width(w);
        m_profile->set_height(h);
    }
    m_profile->set_explicit(1);
    m_previewW = m_profile->width();
    m_previewH = m_profile->height();
    appLog(QString("[ENGINE] preview profile %1x%2 (source %3x%4)")
               .arg(m_previewW)
               .arg(m_previewH)
               .arg(sourceW)
               .arg(sourceH));
}

bool MltController::open(const QString &path)
{
    teardown();
    const QByteArray utf8 = path.toUtf8();

    m_profile = std::make_unique<Mlt::Profile>();
    {
        Mlt::Producer probe(*m_profile, "loader", utf8.constData());
        if (!probe.is_valid()) {
            return false;
        }
        m_profile->from_producer(probe);
    }
    configurePreviewProfile(m_profile->width(), m_profile->height());

    auto producer = std::make_unique<Mlt::Producer>(*m_profile, "loader", utf8.constData());
    if (!producer->is_valid()) {
        return false;
    }
    m_fps = producer->get_fps();
    if (m_fps <= 0.0) {
        m_fps = m_profile->fps();
    }
    m_length = producer->get_length();
    m_root = std::move(producer);

    beginConsumer();
    emit opened(durationSeconds(), m_fps);
    emit playingChanged(false);
    return true;
}

bool MltController::openProject(const ProjectData &project)
{
    teardown();

    appLog(QString("[ENGINE] openProject name=\"%1\" dur=%2s fps=%3 canvas=%4x%5 tracks=%6")
               .arg(project.name)
               .arg(project.duration, 0, 'f', 1)
               .arg(project.fps, 0, 'f', 3)
               .arg(project.canvasW)
               .arg(project.canvasH)
               .arg(project.tracks.size()));

    m_profile = std::make_unique<Mlt::Profile>();
    m_profile->set_frame_rate(static_cast<int>(std::lround(project.fps > 0 ? project.fps : 30.0)), 1);
    m_profile->set_width(project.canvasW);
    m_profile->set_height(project.canvasH);
    m_profile->set_sample_aspect(1, 1);
    m_profile->set_progressive(1);
    configurePreviewProfile(project.canvasW, project.canvasH);
    m_fps = m_profile->fps();

    const double fps = m_fps;
    const auto sec2f = [&](double s) { return static_cast<int>(std::llround(s * fps)); };
    const int totalFrames = std::max(1, sec2f(project.duration));
    m_length = totalFrames;

    auto tractor = std::make_unique<Mlt::Tractor>(*m_profile);

    m_background = std::make_unique<Mlt::Producer>(*m_profile, "colour", "black");
    m_background->set("length", totalFrames);
    m_background->set_in_and_out(0, totalFrames - 1);
    tractor->set_track(*m_background, 0);

    int trackIndex = 1;
    for (int ti = project.tracks.size() - 1; ti >= 0; --ti) {
        const TrackInfo &track = project.tracks[ti];
        if (track.hidden) {
            continue;
        }
        const bool isAudio = (track.kind == "audio");
        const bool isText = (track.kind == "text");

        auto playlist = std::make_unique<Mlt::Playlist>(*m_profile);

        QVector<ClipInfo> clips = track.clips;
        std::sort(clips.begin(), clips.end(),
                  [](const ClipInfo &a, const ClipInfo &b) { return a.timelineStart < b.timelineStart; });

        int cursor = 0;
        for (const ClipInfo &clip : clips) {
            MediaInfo mi;
            std::unique_ptr<Mlt::Producer> producer;
            if (isText) {
                const QString textArg = "+" + (clip.text.isEmpty() ? QString("Text") : clip.text);
                producer = std::make_unique<Mlt::Producer>(*m_profile, "qtext", textArg.toUtf8().constData());
                if (producer->is_valid()) {
                    producer->set("text", clip.text.toUtf8().constData());
                    producer->set("fgcolour", "#ffffffff");
                    producer->set("bgcolour", "#00000000");
                    producer->set("olcolour", "#000000aa");
                    producer->set("outline", 2);
                    producer->set("align", "center");
                    producer->set("size", 48);
                    producer->set("family", "Helvetica");
                }
            } else {
                mi = project.media.value(clip.mediaId);
                if (mi.path.isEmpty()) {
                    continue;
                }
                producer =
                    std::make_unique<Mlt::Producer>(*m_profile, "loader", mi.path.toUtf8().constData());
            }
            if (!producer->is_valid()) {
                continue;
            }
            producer->set(isAudio ? "video_index" : "audio_index", "-1");

            const double textDuration =
                std::max(0.1, (clip.timelineEnd > clip.timelineStart ? clip.timelineEnd - clip.timelineStart : 3.0));
            int inF = isText ? 0 : sec2f(clip.sourceStart);
            int outF = (isText ? sec2f(textDuration) : sec2f(clip.sourceEnd)) - 1;
            if (outF < inF) {
                outF = inF;
            }

            const auto attachFilter = [&](const char *id, auto configure) {
                auto filter = std::make_unique<Mlt::Filter>(*m_profile, id);
                if (!filter->is_valid()) {
                    return;
                }
                configure(*filter);
                producer->attach(*filter);
                m_filters.push_back(std::move(filter));
            };

            if (!isAudio) {
                if (!nearly(clip.scale, 1.0) || !nearly(clip.x, 0.0) || !nearly(clip.y, 0.0)
                    || !nearly(clip.rotation, 0.0) || !nearly(clip.opacity, 1.0) || isText) {
                    attachFilter("affine", [&](Mlt::Filter &filter) {
                        filter.set("use_normalized", 1);
                        filter.set("transition.rect", rectForClip(clip, project.canvasW, project.canvasH).toUtf8().constData());
                        filter.set("transition.fix_rotate_z", clip.rotation);
                        filter.set("transition.b_alpha", 1);
                        filter.set("transition.fill", 1);
                    });
                }

                if (!nearly(clip.brightness, 1.0)) {
                    attachFilter("brightness", [&](Mlt::Filter &filter) {
                        filter.set("level", clip.brightness);
                        filter.set("rgb_only", 1);
                    });
                }

                if (clip.flipH) {
                    attachFilter("mirror", [&](Mlt::Filter &filter) { filter.set("mirror", "horizontal"); });
                }
                if (clip.flipV) {
                    attachFilter("mirror", [&](Mlt::Filter &filter) { filter.set("mirror", "vertical"); });
                }

                if (clip.hasCrop) {
                    attachFilter("crop", [&](Mlt::Filter &filter) {
                        filter.set("active", 1);
                        filter.set("use_profile", 1);
                        filter.set("left", static_cast<int>(std::lround(clip.cropX * project.canvasW)));
                        filter.set("right", static_cast<int>(std::lround(std::max(0.0, 1.0 - clip.cropX - clip.cropW) * project.canvasW)));
                        filter.set("top", static_cast<int>(std::lround(clip.cropY * project.canvasH)));
                        filter.set("bottom", static_cast<int>(std::lround(std::max(0.0, 1.0 - clip.cropY - clip.cropH) * project.canvasH)));
                    });
                }

                if (clip.hasMask) {
                    attachFilter("qtcrop", [&](Mlt::Filter &filter) {
                        filter.set("rect", QString("%1%/%2%:%3%x%4%")
                                               .arg(clip.maskX * 100.0, 0, 'f', 2)
                                               .arg(clip.maskY * 100.0, 0, 'f', 2)
                                               .arg(clip.maskW * 100.0, 0, 'f', 2)
                                               .arg(clip.maskH * 100.0, 0, 'f', 2)
                                               .toUtf8()
                                               .constData());
                        filter.set("color", "#00000000");
                    });
                }

                if (clip.chromaEnabled) {
                    attachFilter("chroma", [&](Mlt::Filter &filter) {
                        filter.set("key", clip.chromaColor.toUtf8().constData());
                        filter.set("variance", clip.chromaSimilarity);
                    });
                }
            }

            if (isAudio && !nearly(clip.volume, 1.0)) {
                attachFilter("volume", [&](Mlt::Filter &filter) {
                    filter.set("gain", QString::number(std::max(0.0, clip.volume)).toUtf8().constData());
                });
            }

            const int startF = sec2f(clip.timelineStart);
            if (startF > cursor) {
                playlist->blank(startF - cursor - 1);
                cursor = startF;
            }
            playlist->append(*producer, inF, outF);
            cursor += (outF - inF + 1);
            m_clipProducers.push_back(std::move(producer));
        }

        tractor->set_track(*playlist, trackIndex);

        if (isAudio) {
            auto mix = std::make_unique<Mlt::Transition>(*m_profile, "mix");
            mix->set("always_active", 1);
            mix->set("sum", 1);
            tractor->plant_transition(*mix, 0, trackIndex);
            m_transitions.push_back(std::move(mix));
        } else {
            auto blend = std::make_unique<Mlt::Transition>(*m_profile, "qtblend");
            tractor->plant_transition(*blend, 0, trackIndex);
            m_transitions.push_back(std::move(blend));
        }

        m_playlists.push_back(std::move(playlist));
        ++trackIndex;
    }

    m_root = std::move(tractor);

    beginConsumer();
    emit opened(durationSeconds(), m_fps);
    emit playingChanged(false);
    return true;
}

bool MltController::exportToFile(const QString &path)
{
    if (!m_profile || !m_root || path.isEmpty()) {
        return false;
    }

    const bool wasPlaying = isPlaying();
    if (m_consumer) {
        if (m_frameEvent) {
            m_frameEvent->block();
            Mlt::Properties::delete_event(m_frameEvent);
            m_frameEvent = nullptr;
        }
        m_consumer->stop();
        m_consumer.reset();
    }

    m_root->set_speed(1.0);
    m_root->seek(0);

    Mlt::Consumer consumer(*m_profile, "avformat", path.toUtf8().constData());
    if (!consumer.is_valid()) {
        beginConsumer();
        return false;
    }
    consumer.set("real_time", -1);
    consumer.set("vcodec", "libx264");
    consumer.set("acodec", "aac");
    consumer.set("preset", "veryfast");
    consumer.set("crf", 18);
    consumer.connect(*m_root);
    const int rc = consumer.run();

    m_root->set_speed(0.0);
    m_root->seek(0);
    beginConsumer();
    if (wasPlaying) {
        play();
    }
    return rc == 0;
}

void MltController::beginConsumer()
{
    m_consumer = std::make_unique<Mlt::Consumer>(*m_profile, "sdl2_audio");
    if (!m_consumer->is_valid()) {
        return;
    }
    m_consumer->set("terminate_on_pause", 0);
    if (m_frameEvent) {
        m_frameEvent->block();
        Mlt::Properties::delete_event(m_frameEvent);
        m_frameEvent = nullptr;
    }
    m_frameEvent = m_consumer->listen("consumer-frame-show", this, (mlt_listener) MltController::on_frame_show);
    m_consumer->connect(*m_root);
    m_root->set_speed(0);
    m_consumer->start();
    refresh();
}

double MltController::durationSeconds() const
{
    if (m_fps <= 0.0) {
        return 0.0;
    }
    return m_length / m_fps;
}

bool MltController::isPlaying() const
{
    return m_root && m_root->get_speed() != 0.0;
}

void MltController::refresh()
{
    if (m_consumer) {
        m_consumer->set("refresh", 1);
    }
}

void MltController::play()
{
    if (!m_root || !m_consumer) {
        return;
    }
    if (m_consumer->is_stopped()) {
        m_consumer->start();
    }
    m_root->set_speed(1.0);
    refresh();
    emit playingChanged(true);
}

void MltController::pause()
{
    if (!m_root || !m_consumer) {
        return;
    }
    m_root->set_speed(0.0);
    m_consumer->purge();
    refresh();
    emit playingChanged(false);
}

void MltController::togglePlay()
{
    if (isPlaying()) {
        pause();
    } else {
        play();
    }
}

void MltController::seekFrame(int frame)
{
    if (!m_root || !m_consumer) {
        return;
    }
    if (frame < 0) {
        frame = 0;
    }
    if (m_length > 0 && frame >= m_length) {
        frame = m_length - 1;
    }
    m_root->set_speed(0.0);
    m_root->seek(frame);
    m_consumer->purge();
    refresh();
    appLog(QString("[ENGINE] seekFrame -> %1 (pos now %2, speed %3)")
               .arg(frame)
               .arg(m_root->position())
               .arg(m_root->get_speed()));
    emit playingChanged(false);
}

void MltController::seekSeconds(double seconds)
{
    seekFrame(static_cast<int>(seconds * m_fps + 0.5));
}

void MltController::on_frame_show(mlt_properties /*owner*/, void *self, mlt_event_data data)
{
    auto *c = static_cast<MltController *>(self);
    mlt_frame frameHandle = mlt_event_data_to_frame(data);
    if (!frameHandle || !c) {
        return;
    }

    Mlt::Frame frame(frameHandle);
    mlt_image_format format = mlt_image_rgba;
    int w = c->m_previewW;
    int h = c->m_previewH;
    const uint8_t *image = frame.get_image(format, w, h);
    if (image && w > 0 && h > 0) {
        QImage owned(w, h, QImage::Format_RGBA8888);
        std::memcpy(owned.bits(), image, static_cast<size_t>(w) * h * 4);
        emit c->frameReady(owned);
    }

    const int pos = frame.get_position();
    if (c->m_root && c->m_root->get_speed() == 0.0) {
        appLog(QString("[ENGINE] frame-show pos=%1 (seek/paused)").arg(pos));
    }
    emit c->positionChanged(pos, c->m_fps > 0.0 ? pos / c->m_fps : 0.0);
}
