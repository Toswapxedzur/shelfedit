#include "MltController.h"

#include <cstring>
#include <cstdio>

#include <mlt++/Mlt.h>

namespace {
constexpr int kMaxPreviewWidth = 1280;
}

MltController::MltController(QObject *parent)
    : QObject(parent)
{
}

MltController::~MltController()
{
    if (m_consumer) {
        m_consumer->stop();
    }
    // Destroy in dependency order: consumer, then producer, then profile.
    m_consumer.reset();
    m_producer.reset();
    m_profile.reset();
}

bool MltController::open(const QString &path)
{
    const QByteArray utf8 = path.toUtf8();

    // Probe the source against a scratch profile so we can size the preview
    // profile to match the footage, then downscale for cheap preview decode.
    m_profile = std::make_unique<Mlt::Profile>();
    {
        // Use the "loader" producer (not bare "avformat") so MLT attaches the
        // color-space / image-format normalizers. Without them get_image()
        // cannot convert to RGBA and returns native YUV.
        Mlt::Producer probe(*m_profile, "loader", utf8.constData());
        if (!probe.is_valid()) {
            return false;
        }
        m_profile->from_producer(probe);
    }

    int w = m_profile->width();
    int h = m_profile->height();
    if (w > kMaxPreviewWidth && w > 0) {
        const double f = static_cast<double>(kMaxPreviewWidth) / w;
        w = kMaxPreviewWidth & ~1;
        h = (static_cast<int>(h * f)) & ~1;
        m_profile->set_width(w);
        m_profile->set_height(h);
    }
    m_profile->set_explicit(1);
    m_previewW = m_profile->width();
    m_previewH = m_profile->height();

    // The real producer, now bound to the (preview-sized) profile.
    m_producer = std::make_unique<Mlt::Producer>(*m_profile, "loader", utf8.constData());
    if (!m_producer->is_valid()) {
        return false;
    }
    m_fps = m_producer->get_fps();
    if (m_fps <= 0.0) {
        m_fps = m_profile->fps();
    }
    m_length = m_producer->get_length();

    // Audio consumer = master clock. Video is pulled in the frame-show handler.
    m_consumer = std::make_unique<Mlt::Consumer>(*m_profile, "sdl2_audio");
    if (!m_consumer->is_valid()) {
        return false;
    }
    m_consumer->set("terminate_on_pause", 0);
    m_consumer->listen("consumer-frame-show", this, (mlt_listener) MltController::on_frame_show);
    m_consumer->connect(*m_producer);

    m_producer->set_speed(0);
    m_consumer->start();
    refresh(); // render the first frame while paused

    emit opened(durationSeconds(), m_fps);
    emit playingChanged(false);
    return true;
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
    return m_producer && m_producer->get_speed() != 0.0;
}

void MltController::refresh()
{
    if (m_consumer) {
        m_consumer->set("refresh", 1);
    }
}

void MltController::play()
{
    if (!m_producer || !m_consumer) {
        return;
    }
    if (m_consumer->is_stopped()) {
        m_consumer->start();
    }
    m_producer->set_speed(1.0);
    refresh();
    emit playingChanged(true);
}

void MltController::pause()
{
    if (!m_producer || !m_consumer) {
        return;
    }
    m_producer->set_speed(0.0);
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
    if (!m_producer || !m_consumer) {
        return;
    }
    if (frame < 0) {
        frame = 0;
    }
    if (m_length > 0 && frame >= m_length) {
        frame = m_length - 1;
    }
    m_producer->set_speed(0.0);
    m_producer->seek(frame);
    m_consumer->purge();
    refresh();
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
        // Copy out of MLT's buffer into an owned QImage before it crosses
        // the thread boundary. mlt_image_rgba matches Format_RGBA8888 byte
        // order, so no channel swap is needed.
        QImage owned(w, h, QImage::Format_RGBA8888);
        std::memcpy(owned.bits(), image, static_cast<size_t>(w) * h * 4);
        emit c->frameReady(owned);
    }

    const int pos = frame.get_position();
    emit c->positionChanged(pos, c->m_fps > 0.0 ? pos / c->m_fps : 0.0);
}
