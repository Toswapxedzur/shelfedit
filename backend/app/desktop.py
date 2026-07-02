"""Python-native desktop shell.

Launches the local backend engine in a background thread, waits until it is
healthy, then opens a native OS window that displays the built UI. To the user
this is a single desktop app; there is no server to start manually and nothing
is exposed to the network.

Run with:
    python -m app.desktop
(after building the frontend: `npm run build` in ../frontend)
"""

from __future__ import annotations

import socket
import threading
import time
import urllib.request

import uvicorn

from .config import get_settings
from .main import app, _WEBUI_DIR


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(base_url: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=1) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def _run_backend(port: int) -> None:
    # 127.0.0.1 only: the engine is never exposed to the network.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


class DesktopApi:
    """Bridge exposed to the UI as `window.pywebview.api`.

    Lets the web UI open a native file dialog and get back an absolute local
    path, so large videos are never uploaded — the backend reads them from disk.
    """

    def __init__(self) -> None:
        self.window = None  # set after the window is created

    def pick_video_file(self):
        import webview

        file_types = (
            "Video files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)",
            "All files (*.*)",
        )
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
        )
        if not result:
            return None
        # pywebview returns a tuple/list of selected paths.
        return result[0] if isinstance(result, (list, tuple)) else result


def main() -> None:
    settings = get_settings()

    if not _WEBUI_DIR.is_dir():
        raise SystemExit(
            "UI is not built yet. Run `npm run build` in the frontend/ folder first."
        )

    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    backend_thread = threading.Thread(target=_run_backend, args=(port,), daemon=True)
    backend_thread.start()

    if not _wait_for_health(base_url):
        raise SystemExit("Backend engine did not start in time.")

    # Imported here so the API can run headless (tests/CI) without a GUI toolkit.
    import webview

    desktop_api = DesktopApi()
    window = webview.create_window(
        settings.app_name,
        base_url,
        width=1200,
        height=800,
        min_size=(900, 600),
        js_api=desktop_api,
    )
    desktop_api.window = window
    webview.start()


if __name__ == "__main__":
    main()
