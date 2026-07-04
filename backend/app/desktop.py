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

import json
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

    It also manages the detachable AI agent window: the main editor window is
    the single source of truth, and the agent window (a second native window)
    relays its edits back through here so both windows behave as one workspace.
    """

    def __init__(self) -> None:
        self.window = None  # main editor window; set after it is created
        self.agent_window = None  # second window for the detached AI agent
        self.base_url = ""

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

    def pick_save_path(self, suggested_name: str | None = None):
        """Native "Save as…" dialog. Returns an absolute path, or None."""
        import webview

        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=suggested_name or "export.mp4",
            file_types=(
                "Video files (*.mp4;*.mov;*.webm)",
                "All files (*.*)",
            ),
        )
        if not result:
            return None
        return result[0] if isinstance(result, (list, tuple)) else result

    # --- Detachable AI agent window ---------------------------------------

    def _notify_reattach(self) -> None:
        """Tell the main window to re-dock the AI panel."""
        if self.window is None:
            return
        try:
            self.window.evaluate_js(
                "window.__agentClosed && window.__agentClosed()"
            )
        except Exception:
            pass

    def open_agent_window(self, project_id: str):
        """Open the AI assistant as a second native window."""
        import webview

        if self.agent_window is not None:
            return True  # already open

        url = f"{self.base_url}/?view=agent&project={project_id}"
        win = webview.create_window(
            "AI Assistant",
            url,
            width=460,
            height=820,
            min_size=(360, 480),
            js_api=self,
        )
        self.agent_window = win

        def _on_closed() -> None:
            self.agent_window = None
            self._notify_reattach()

        try:
            win.events.closed += _on_closed
        except Exception:
            pass
        return True

    def close_agent_window(self):
        """Close the agent window (the "Attach" action) and re-dock the panel."""
        win = self.agent_window
        self.agent_window = None
        if win is not None:
            try:
                win.destroy()
            except Exception:
                pass
        self._notify_reattach()
        return True

    def dispatch_to_editor(self, payload_json: str):
        """Relay an agent message into the main editor window.

        `payload_json` is a JSON string (a command or a reload request). We
        double-encode it so it is embedded as a safe JS string literal.
        """
        if self.window is None:
            return False
        js_literal = json.dumps(payload_json)
        try:
            self.window.evaluate_js(
                f"window.__agentDispatch && window.__agentDispatch({js_literal})"
            )
            return True
        except Exception:
            return False


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
    desktop_api.base_url = base_url
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
