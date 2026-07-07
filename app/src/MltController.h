#pragma once

#include <QObject>
#include <QImage>
#include <QString>
#include <memory>
#include <vector>

#include <framework/mlt.h>

#include "Timeline.h"

namespace Mlt {
class Profile;
class Producer;
class Playlist;
class Transition;
class Tractor;
class Consumer;
class Event;
class Filter;
}

// The engine layer. Wraps MLT: it owns the profile, the transport root (a single
// producer or a multitrack tractor), and an audio consumer that acts as the
// master clock. Video frames arrive via MLT's "consumer-frame-show" event and
// are emitted as QImages.
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

    // Single-clip graph (Slice 1).
    bool open(const QString &path);
    // Multitrack graph built from a project's timeline (Slice 2 pt.2).
    bool openProject(const ProjectData &project);
    bool exportToFile(const QString &path);

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
    static void on_frame_show(mlt_properties owner, void *self, mlt_event_data data);
    void refresh();
    void beginConsumer();
    void teardown();
    void configurePreviewProfile(int sourceW, int sourceH);

    std::unique_ptr<Mlt::Profile> m_profile;
    std::unique_ptr<Mlt::Producer> m_root; // single producer OR a tractor
    std::unique_ptr<Mlt::Consumer> m_consumer;
    Mlt::Event *m_frameEvent = nullptr;

    // Kept alive for the tractor's lifetime.
    std::unique_ptr<Mlt::Producer> m_background;
    std::vector<std::unique_ptr<Mlt::Producer>> m_clipProducers;
    std::vector<std::unique_ptr<Mlt::Filter>> m_filters;
    std::vector<std::unique_ptr<Mlt::Playlist>> m_playlists;
    std::vector<std::unique_ptr<Mlt::Transition>> m_transitions;

    int m_previewW = 0;
    int m_previewH = 0;
    double m_fps = 25.0;
    int m_length = 0;
};
