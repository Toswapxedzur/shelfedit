"use strict";

function formatTime(seconds) {
    if (!seconds || seconds < 0) seconds = 0;
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const cs = Math.floor((seconds - total) * 100);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

window.addEventListener("load", () => {
    const playBtn = document.getElementById("play");
    const scrub = document.getElementById("scrub");
    const timeEl = document.getElementById("time");
    const statusEl = document.getElementById("status");

    let duration = 0;
    let scrubbing = false;

    const render = (pos) => {
        timeEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    };

    new QWebChannel(qt.webChannelTransport, (channel) => {
        const bridge = channel.objects.bridge;
        window.bridge = bridge; // handy for debugging in devtools

        // Pull initial state (signals may have fired before we connected).
        bridge.durationSeconds((d) => {
            duration = d;
            scrub.disabled = !(d > 0);
            playBtn.disabled = !(d > 0);
            render(0);
        });
        bridge.playing((p) => {
            playBtn.textContent = p ? "Pause" : "Play";
        });

        playBtn.addEventListener("click", () => bridge.togglePlay());
        scrub.addEventListener("input", () => {
            scrubbing = true;
            if (duration > 0) bridge.seek((scrub.value / 1000) * duration);
        });
        scrub.addEventListener("change", () => {
            scrubbing = false;
        });

        bridge.opened.connect((d, _fps) => {
            duration = d;
            scrub.disabled = !(d > 0);
            playBtn.disabled = !(d > 0);
            render(0);
        });
        bridge.positionChanged.connect((pos, dur) => {
            duration = dur;
            if (!scrubbing && dur > 0) {
                scrub.value = Math.round((pos / dur) * 1000);
            }
            render(pos);
        });
        bridge.playingChanged.connect((p) => {
            playBtn.textContent = p ? "Pause" : "Play";
        });

        statusEl.textContent = "connected to engine";
        console.log("channel ready");
    });
});
