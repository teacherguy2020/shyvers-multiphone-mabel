#!/usr/bin/env python3
"""Capture the current Multiphone playlist and Version 10 layout fixture.

This is an explicit, read-only source-capture step. It reads the existing
Track Key from Keychain, queries the read-only playlist endpoint, reads MPD
metadata over the existing SSH path, and extracts measured coordinates from
the supplied populated Version 10 PDF. It never writes to moOde or playback.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


PAGE_WIDTH = 792.0
PAGE_HEIGHT = 612.0
FULL_WIDTH = 1062.0
FULL_HEIGHT = 432.0
PAGE1_FULL_X_OFFSET = -46.0
PAGE2_FULL_X_OFFSET = 591.2
FULL_Y_OFFSET = -92.0

TOP_CATEGORIES = {
    1: {"category": "Crooner's Corner", "heading": "CROONERS", "panel": 1},
    2: {"category": "Swing Time!", "heading": "SWING TIME!", "panel": 2},
    3: {"category": "Sweethearts & Serenades", "heading": "SWEETHEARTS & SERENADES", "panel": 3},
    4: {"category": "After Hours", "heading": "AFTER HOURS", "panel": 4},
    5: {"category": "Mabel's Favorites", "heading": "MABEL'S FAVORITES", "panel": 5},
}

SUBGROUPS = {
    "Nat King Cole": {54},
    "Dance & Show Tunes": {19, 51, 53, 108},
    "Love Songs": {90, 93, 95, 96, 99, 101, 103, 105, 109, 113, 115, 118, 126, 129},
    "Sentimental Favorites": {140, 142, 143, 145, 148, 152, 153},
    "Blues & Ballads": {123, 125, 128, 131, 133, 134, 137, 139, 144, 147, 150},
    "Midnight Melodies": {151, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170},
    "Jazz Club": {120, 121, 122, 124, 127, 130, 132, 135, 136},
    "Requests & Rarities": {138, 141, 146, 149, 154, 155, 156, 157, 158, 159},
}

COLUMNS = {
    (1, 67.0): (1, 1, 216.2),
    (1, 279.4): (2, 2, 428.6),
    (1, 491.8): (3, 3, 641.0),
    (2, 67.0): (4, 4, 216.2),
    (2, 279.4): (5, 5, 428.6),
}

HEADINGS = [
    {"page": 1, "x": 132.829830, "y_top": 135.175684, "text": "CROONERS", "kind": "category", "panel": 1},
    {"page": 1, "x": 340.810200, "y_top": 135.175684, "text": "SWING TIME!", "kind": "category", "panel": 2},
    {"page": 1, "x": 517.481100, "y_top": 135.175684, "text": "SWEETHEARTS & SERENADES", "kind": "category", "panel": 3},
    {"page": 1, "x": 763.460200, "y_top": 135.175684, "text": "AFTER HOURS", "kind": "category", "panel": 4},
    {"page": 2, "x": 126.260220, "y_top": 135.175684, "text": "AFTER HOURS", "kind": "category", "panel": 4},
    {"page": 2, "x": 324.082620, "y_top": 135.175684, "text": "MABEL'S FAVORITES", "kind": "category", "panel": 5},
    {"page": 1, "x": 554.161300, "y_top": 261.587484, "text": "LOVE SONGS", "kind": "subgroup", "panel": 3},
    {"page": 1, "x": 524.057100, "y_top": 396.646284, "text": "SENTIMENTAL FAVORITES", "kind": "subgroup", "panel": 3},
    {"page": 1, "x": 319.784700, "y_top": 417.433784, "text": "DANCE & SHOW TUNES", "kind": "subgroup", "panel": 2},
    {"page": 1, "x": 754.255500, "y_top": 260.418884, "text": "BLUES & BALLADS", "kind": "subgroup", "panel": 4},
    {"page": 1, "x": 746.974000, "y_top": 361.824284, "text": "MIDNIGHT MELODIES", "kind": "subgroup", "panel": 4},
    {"page": 2, "x": 117.055520, "y_top": 260.418884, "text": "BLUES & BALLADS", "kind": "subgroup", "panel": 4},
    {"page": 2, "x": 109.774020, "y_top": 361.824284, "text": "MIDNIGHT MELODIES", "kind": "subgroup", "panel": 4},
    {"page": 2, "x": 345.586820, "y_top": 296.175684, "text": "JAZZ CLUB", "kind": "subgroup", "panel": 5},
    {"page": 2, "x": 320.135320, "y_top": 379.807284, "text": "REQUESTS & RARITIES", "kind": "subgroup", "panel": 5},
]


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def read_bbox(pdf_path: Path, page: int) -> list[dict[str, object]]:
    command = ["pdftotext", "-bbox-layout", "-f", str(page), "-l", str(page), str(pdf_path), "-"]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or "pdftotext failed")
    root = ET.fromstring(result.stdout)
    words = []
    for elem in root.iter():
        if local_name(elem.tag) != "word":
            continue
        words.append({
            "x": float(elem.attrib["xMin"]),
            "y": float(elem.attrib["yMin"]),
            "x_max": float(elem.attrib["xMax"]),
            "y_max": float(elem.attrib["yMax"]),
            "text": elem.text or "",
        })
    return words


def find_slots(version10: Path) -> list[dict[str, object]]:
    pages = {1: read_bbox(version10, 1), 2: read_bbox(version10, 2)}
    slots = []
    for (page, number_x), (panel, panel_again, artist_x) in COLUMNS.items():
        assert panel == panel_again
        words = pages[page]
        number_words = [
            word for word in words
            if abs(float(word["x"]) - number_x) < 0.5
            and 140.0 <= float(word["y"]) <= 465.0
            and re.fullmatch(r"\d{1,3}", str(word["text"]))
        ]
        for number_word in number_words:
            number = int(str(number_word["text"]))
            row_y = float(number_word["y"])
            row_words = [
                word for word in words
                if abs(float(word["y"]) - row_y) <= 2.0
                and number_x + 10.0 <= float(word["x"]) < number_x + 210.0
                and _winansi_word(word)
            ]
            row_words = [word for word in row_words if str(word["text"]) != str(number)]
            row_words.sort(key=lambda word: float(word["x"]))
            gaps = [
                (float(right["x"]) - float(left["x_max"]), index)
                for index, (left, right) in enumerate(zip(row_words, row_words[1:]))
            ]
            split_gap, split_index = max(gaps, default=(0.0, -1))
            if split_gap < 8.0:
                raise RuntimeError(f"Could not separate Version 10 title/artist for selection {number}")
            title_words = row_words[:split_index + 1]
            artist_words = row_words[split_index + 1:]
            if not title_words or not artist_words:
                raise RuntimeError(f"Could not extract Version 10 text for selection {number} on page {page}")
            subgroup = next((name for name, numbers in SUBGROUPS.items() if number in numbers), "")
            top = TOP_CATEGORIES[panel]
            slots.append({
                "selection_number": number,
                "page": page,
                "panel": panel,
                "category": top["category"],
                "category_heading": top["heading"],
                "subgroup": subgroup,
                "number_x": float(number_word["x"]),
                "title_x": float(title_words[0]["x"]),
                "title_x_max": max(float(word["x_max"]) for word in title_words),
                "artist_x": float(artist_words[0]["x"]),
                "artist_x_max": max(float(word["x_max"]) for word in artist_words),
                "number_y_top": float(number_word["y"]),
                "number_y_max": float(number_word["y_max"]),
                "title_y_top": min(float(word["y"]) for word in title_words),
                "title_y_max": max(float(word["y_max"]) for word in title_words),
                "artist_y_top": min(float(word["y"]) for word in artist_words),
                "artist_y_max": max(float(word["y_max"]) for word in artist_words),
                "printable_title": " ".join(str(word["text"]) for word in title_words),
                "printable_artist": " ".join(str(word["text"]) for word in artist_words),
            })
    by_number = {int(slot["selection_number"]): slot for slot in slots}
    expected = set(range(1, 171))
    if set(by_number) != expected or len(slots) != 170:
        missing = sorted(expected - set(by_number))
        duplicates = sorted(number for number in set(by_number) if sum(int(slot["selection_number"]) == number for slot in slots) > 1)
        raise RuntimeError(f"Version 10 slot extraction failed: missing={missing}, duplicates={duplicates}")
    return [by_number[number] for number in sorted(by_number)]


def _winansi_word(word: dict[str, object]) -> bool:
    if str(word["text"]).upper() == "REQUESTS":
        # Vertical artwork lettering shares some catalog row y-ranges.
        return False
    try:
        str(word["text"]).encode("cp1252")
        return True
    except UnicodeEncodeError:
        # The artwork's musical-note glyph can sit inside a text row in the
        # facsimile's extraction order. It is not catalog text.
        return False


def read_playlist(endpoint: str) -> dict[str, object]:
    key_result = subprocess.run(
        ["security", "find-generic-password", "-s", "Shyvers Multiphone / Now Playing", "-a", "multiphone-operator", "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if key_result.returncode or not key_result.stdout.strip():
        raise RuntimeError("Track Key is not available in Keychain")
    request = urllib.request.Request(endpoint, headers={"X-Track-Key": key_result.stdout.strip()})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode())


def read_mpd_metadata(host: str) -> dict[str, dict[str, str]]:
    remote_command = "mpc -f '%file%\\t%title%\\t%artist%\\t%album%' listall"
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", f"moode@{host}", remote_command],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"MPD metadata read failed: {result.stderr.strip()}")
    metadata = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) < 4:
            continue
        file_name, title, artist, album = fields[:4]
        metadata.setdefault(file_name, {"full_title": title.strip(), "full_artist": artist.strip(), "album": album.strip()})
    return metadata


def collect(args: argparse.Namespace) -> None:
    playlist_payload = read_playlist(args.playlist_endpoint)
    tracks = playlist_payload.get("tracks") if isinstance(playlist_payload, dict) else None
    if not isinstance(tracks, list):
        raise RuntimeError("Playlist response did not contain a tracks list")
    metadata = read_mpd_metadata(args.mpd_host)
    slots = find_slots(args.version10)
    slot_by_number = {int(slot["selection_number"]): slot for slot in slots}
    rows = []
    for track in tracks:
        number = int(track.get("number", 0))
        file_name = str(track.get("file") or "")
        row = {"selection_number": number, "moode_file": file_name, **metadata.get(file_name, {})}
        if not row.get("full_title") or not row.get("full_artist"):
            raise RuntimeError(f"Missing MPD metadata for selection {number}: {file_name}")
        row.update({
            "printable_title": slot_by_number[number]["printable_title"],
            "printable_artist": slot_by_number[number]["printable_artist"],
            "category": slot_by_number[number]["category"],
            "panel": slot_by_number[number]["panel"],
            "subgroup": slot_by_number[number]["subgroup"],
        })
        rows.append(row)
    numbers = [int(row["selection_number"]) for row in rows]
    if numbers != list(range(1, 171)):
        raise RuntimeError("Current playlist numbers are not exactly 1 through 170 in order")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "source": {
            "playlist_endpoint": args.playlist_endpoint,
            "playlist": playlist_payload.get("playlist"),
            "mpd_host": args.mpd_host,
            "version10_reference": str(args.version10),
        },
        "tracks": rows,
    }, indent=2, ensure_ascii=False) + "\n")
    args.layout_output.parent.mkdir(parents=True, exist_ok=True)
    args.layout_output.write_text(json.dumps({
        "page_size": {"width": PAGE_WIDTH, "height": PAGE_HEIGHT},
        "full_size": {"width": FULL_WIDTH, "height": FULL_HEIGHT},
        "crop_offsets": {"page1_to_full_x": PAGE1_FULL_X_OFFSET, "page2_to_full_x": PAGE2_FULL_X_OFFSET, "page_to_full_y": FULL_Y_OFFSET},
        "headings": HEADINGS,
        "slots": slots,
    }, indent=2, ensure_ascii=False) + "\n")
    print(f"PASS: captured {len(rows)} live playlist rows and {len(slots)} Version 10 slots")
    print(f"WROTE: {args.output}")
    print(f"WROTE: {args.layout_output}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version10", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--layout-output", type=Path, required=True)
    parser.add_argument("--playlist-endpoint", default="http://10.0.0.4:3103/integrations/multiphone/playlist")
    parser.add_argument("--mpd-host", default="10.0.0.254")
    args = parser.parse_args()
    collect(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(f"collect_sources: {exc}")
