"""
Generates the extension icons (PNG) with zero dependencies: a blush "sticky note"
with a plum hand-drawn mindmap glyph (centre node + four branches).

    python scripts/make_icons.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
PAPER = (234, 184, 177)
INK = (74, 44, 58)
DOT = (143, 168, 120)


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size: int) -> bytes:
    ss = 4  # supersampling for anti-aliasing
    n = size * ss
    r_corner = n * 0.22
    cx = cy = n / 2
    branches = [(-0.30, -0.28), (0.30, -0.28), (-0.30, 0.28), (0.30, 0.28)]
    stroke = max(1.2, n * 0.055)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x * ss + sx + 0.5, y * ss + sy + 0.5
                    # rounded square mask
                    qx = max(abs(px - cx) - (n / 2 - r_corner), 0)
                    qy = max(abs(py - cy) - (n / 2 - r_corner), 0)
                    if math.hypot(qx, qy) > r_corner:
                        continue
                    color = PAPER
                    d_center = math.hypot(px - cx, py - cy)
                    if abs(d_center - n * 0.13) < stroke * 0.6:
                        color = INK
                    for bx, by in branches:
                        ex, ey = cx + bx * n, cy + by * n
                        sxp, syp = cx + bx * n * 0.42, cy + by * n * 0.42
                        if dist_to_segment(px, py, sxp, syp, ex, ey) < stroke * 0.5:
                            color = INK
                        if math.hypot(px - ex, py - ey) < n * 0.075:
                            color = DOT if math.hypot(px - ex, py - ey) < n * 0.075 - stroke * 0.7 else INK
                    for i, c in enumerate(color):
                        acc[i] += c
                    acc[3] += 255
            samples = ss * ss
            covered = acc[3] / 255
            if covered:
                row.extend(int(acc[i] / covered) for i in range(3))
            else:
                row.extend((0, 0, 0))
            row.append(int(acc[3] / samples))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (OUT / f"icon{size}.png").write_bytes(render(size))
        print("wrote", f"icon{size}.png")


if __name__ == "__main__":
    main()
