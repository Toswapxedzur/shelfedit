#include "MainWindow.h"

#include "MltController.h"
#include "VideoWidget.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QSlider>
#include <QVBoxLayout>
#include <QWidget>

namespace {
constexpr int kSliderResolution = 1000;

QString formatTime(double seconds)
{
    if (seconds < 0.0) {
        seconds = 0.0;
    }
    const int total = static_cast<int>(seconds);
    const int m = total / 60;
    const int s = total % 60;
    const int cs = static_cast<int>((seconds - total) * 100.0);
    return QString("%1:%2.%3")
        .arg(m, 2, 10, QChar('0'))
        .arg(s, 2, 10, QChar('0'))
        .arg(cs, 2, 10, QChar('0'));
}
} // namespace

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent)
{
    setWindowTitle("ShelfEdit");
    resize(1100, 720);

    m_controller = new MltController(this);
    m_video = new VideoWidget(this);

    m_playButton = new QPushButton("Play", this);
    m_playButton->setFixedWidth(90);
    m_slider = new QSlider(Qt::Horizontal, this);
    m_slider->setRange(0, kSliderResolution);
    m_timeLabel = new QLabel("00:00.00 / 00:00.00", this);
    m_timeLabel->setMinimumWidth(160);

    auto *transport = new QHBoxLayout;
    transport->setContentsMargins(8, 6, 8, 8);
    transport->addWidget(m_playButton);
    transport->addWidget(m_slider, 1);
    transport->addWidget(m_timeLabel);

    auto *central = new QWidget(this);
    auto *layout = new QVBoxLayout(central);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);
    layout->addWidget(m_video, 1);
    layout->addLayout(transport);
    setCentralWidget(central);

    // Frames arrive on the consumer thread; a queued connection marshals them
    // to the GUI thread (QImage copy is cheap and thread-safe).
    connect(m_controller, &MltController::frameReady,
            m_video, &VideoWidget::setImage, Qt::QueuedConnection);
    connect(m_controller, &MltController::opened, this, &MainWindow::onOpened);
    connect(m_controller, &MltController::positionChanged,
            this, &MainWindow::onPositionChanged, Qt::QueuedConnection);
    connect(m_controller, &MltController::playingChanged, this, &MainWindow::onPlayingChanged);

    connect(m_playButton, &QPushButton::clicked, m_controller, &MltController::togglePlay);
    connect(m_slider, &QSlider::sliderPressed, this, [this] { m_userScrubbing = true; });
    connect(m_slider, &QSlider::sliderReleased, this, [this] { m_userScrubbing = false; });
    connect(m_slider, &QSlider::sliderMoved, this, &MainWindow::onSliderMoved);
}

bool MainWindow::load(const QString &path)
{
    if (path.isEmpty() || !m_controller->open(path)) {
        m_timeLabel->setText("No video");
        return false;
    }
    setWindowTitle(QString("ShelfEdit — %1").arg(path.section('/', -1)));
    return true;
}

void MainWindow::onOpened(double durationSeconds, double /*fps*/)
{
    m_duration = durationSeconds;
    m_timeLabel->setText(QString("00:00.00 / %1").arg(formatTime(m_duration)));
}

void MainWindow::onPositionChanged(int /*frame*/, double seconds)
{
    if (!m_userScrubbing && m_duration > 0.0) {
        const int value = static_cast<int>((seconds / m_duration) * kSliderResolution + 0.5);
        QSignalBlocker blocker(m_slider);
        m_slider->setValue(qBound(0, value, kSliderResolution));
    }
    m_timeLabel->setText(QString("%1 / %2").arg(formatTime(seconds), formatTime(m_duration)));
}

void MainWindow::onPlayingChanged(bool playing)
{
    m_playButton->setText(playing ? "Pause" : "Play");
}

void MainWindow::onSliderMoved(int value)
{
    if (m_duration > 0.0) {
        m_controller->seekSeconds((static_cast<double>(value) / kSliderResolution) * m_duration);
    }
}
