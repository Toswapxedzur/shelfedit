#pragma once

#include <QString>
#include <cstdio>
#include <mutex>

// Dead-simple, always-flushed logger. Writes to both a fixed file and stderr so
// diagnosis never depends on how the app was launched (nohup/detached/etc).
// The file is truncated once per process at first use.
inline void appLog(const QString &line)
{
    static std::mutex mtx;
    static FILE *f = nullptr;
    std::lock_guard<std::mutex> lk(mtx);
    if (!f) {
        f = std::fopen("/tmp/shelfedit.log", "w");
    }
    const QByteArray utf8 = line.toUtf8();
    if (f) {
        std::fprintf(f, "%s\n", utf8.constData());
        std::fflush(f);
    }
    std::fprintf(stderr, "%s\n", utf8.constData());
    std::fflush(stderr);
}
