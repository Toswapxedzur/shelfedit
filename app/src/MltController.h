#pragma once

#include <QObject>
#include <QImage>
#include <QString>
#include <memory>

#include <framework/mlt.h>

namespace Mlt {
class Profile;
class Producer;
class Consumer;
}

// The engine layer. Wraps MLT: it owns the profile, the producer (the media
// graph) and an audio consumer that acts as the master clock. Video frames
// arrive via MLT's "consumer-frame-show" event and are emitted as QImages.
//
// Design invariants (mirrored from Shotcut):
//   - the audio consumer is the master clock; the playhead is derived from it.
//   - we never seek to re-sync during playback; seeking uses purge + refresh.
//   - frames are copied out of MLT into owned QImages before crossing threads.
class MltController : public QObject
{
    Q_OBJECT
public:
    explicit MltController(QObject *parent = nullptr);
    ~MltController() override;

    // Build the graph for a single media file. Slice 1 = one clip.
    bool open(const QString &path);

    double fps() const { return m_fps; }
    int lengthFrames() const { return m_length; }
    double durationSeconds() const;
    bool isPlaying() const;

public slots:
    void play();
    void pause();
    void togglePlay();
    void seekSeconds(double seconds);
    void seekFrame(int frame);

signals:
    // Emitted from the consumer thread; connect with a queued connection.
    void frameReady(const QImage &image);
    void positionChanged(int frame, double seconds);
    void playingChanged(bool playing);
    void opened(double durationSeconds, double fps);

private:
    // MLT event listener (runs on the consumer thread).
    static void on_frame_show(mlt_properties owner, void *self, mlt_event_data data);
    void refresh();

    std::unique_ptr<Mlt::Profile> m_profile;
    std::unique_ptr<Mlt::Producer> m_producer;
    std::unique_ptr<Mlt::Consumer> m_consumer;

    int m_previewW = 0;
    int m_previewH = 0;
    double m_fps = 25.0;
    int m_length = 0;
};
