#pragma once

#include <QImage>
#include <QWidget>

// The native preview surface. MLT paints here: it receives owned QImages from
// the controller and draws them letterboxed. (Slice 1 uses a CPU QPainter blit;
// a later slice can swap this for a QOpenGLWidget without touching the engine.)
class VideoWidget : public QWidget
{
    Q_OBJECT
public:
    explicit VideoWidget(QWidget *parent = nullptr);

public slots:
    void setImage(const QImage &image);

protected:
    void paintEvent(QPaintEvent *event) override;

private:
    QImage m_image;
};
