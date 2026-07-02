"""File hashing.

Video files can be tens of gigabytes, so hashing the whole file on import would
be slow. We use a fast partial hash (head + tail + size) as an integrity/dedupe
marker, which is plenty for the local MVP. Small files are hashed in full.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_FULL_HASH_MAX_BYTES = 8 * 1024 * 1024  # hash small files (<8 MB) in full
_CHUNK = 4 * 1024 * 1024  # 4 MB head and tail sample for large files


def partial_hash(path: Path) -> str:
    """Return a hex digest identifying the file.

    For small files this is a true sha256. For large files it is a sha256 over
    the first and last chunks plus the byte size — fast and good enough to spot
    the same file being imported twice.
    """
    size = path.stat().st_size
    h = hashlib.sha256()
    h.update(str(size).encode())

    with path.open("rb") as f:
        if size <= _FULL_HASH_MAX_BYTES:
            for block in iter(lambda: f.read(_CHUNK), b""):
                h.update(block)
        else:
            h.update(f.read(_CHUNK))
            f.seek(-_CHUNK, 2)
            h.update(f.read(_CHUNK))

    return h.hexdigest()
