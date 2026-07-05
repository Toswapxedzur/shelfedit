#include "Bridge.h"

#include "MltController.h"

Bridge::Bridge(MltController *controller, QObject *parent)
    : QObject(parent)
    , m_controller(controller)
{
    connect(m_controller, &MltController::opened, this, [this](double duration, double fps) {
        m_duration = duration;
        m_fps = fps;
        emit opened(duration, fps);
    });
    connect(m_controller, &MltController::positionChanged, this,
            [this](int /*frame*/, double seconds) {
                m_position = seconds;
                emit positionChanged(seconds, m_duration);
            });
    connect(m_controller, &MltController::playingChanged, this, [this](bool playing) {
        m_playing = playing;
        emit playingChanged(playing);
    });
}

void Bridge::play()
{
    m_controller->play();
}

void Bridge::pause()
{
    m_controller->pause();
}

void Bridge::togglePlay()
{
    m_controller->togglePlay();
}

void Bridge::seek(double seconds)
{
    m_controller->seekSeconds(seconds);
}
