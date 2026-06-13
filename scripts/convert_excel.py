#!/usr/bin/env python3
"""
convert_excel.py — Excel build order → styled HTML (Age of Mythology: Retold)
Deities of Death / Kries-Dev/BuildOrders

Usage:
    python scripts/convert_excel.py ExcelUploads/MyBuild.xlsx [more.xlsx ...] --outdir BO

Excel layout expected (per sheet, first sheet used):
    Col A: resource allocation "3/0/0/1"  OR section header text (e.g. "ARCHAIC")
    Col B: instruction text (icons substituted inline)
    Col C: side note text (icons substituted inline)
    A row whose col A is empty and col B contains a YouTube URL embeds the video.
    Sheet name or filename provides the page title: "{God} - {BuildName} - {Author}.xlsx"
"""

from __future__ import annotations
import argparse
import html
import json
import re
import sys
from pathlib import Path

import pandas as pd

# ─────────────────────────────────────────────────────────────────────────────
# Icon configuration
# ─────────────────────────────────────────────────────────────────────────────
ICON_BASE = "https://raw.githubusercontent.com/Kries-Dev/BuildOrders/main/Build%20Orders/Icons/"
LOGO_URL  = "https://raw.githubusercontent.com/Kries-Dev/BuildOrders/main/Build%20Orders/Icons/DoDLogo.png"

# Age name → icon filename (for section title decoration)
AGE_ICONS = {
    "archaic":   "archaic_age_icon.png",
    "classical": "classical_age_icon.png",
    "heroic":    "heroic_age_icon.png",
    "mythic":    "mythic_age_icon.png",
    "wonder":    "wonder_age_icon.png",
}

# CURATED MAP — verified against the actual Build Orders/Icons folder contents.
CURATED = {
    # ── Buildings ───────────────────────────────────────────────────────
    "town center":        "fortified_town_center_icon.png",
    "town centre":        "fortified_town_center_icon.png",
    "tc":                 "fortified_town_center_icon.png",
    "temple":             "temple_icon.png",
    "farm":               "farm_icon.png",
    "shrine":             "shrine_icon.png",
    "dock":               "dock_icon.png",
    "barracks":           "barracks_icon.png",
    "market":             "market_icon.png",
    "house":              "house_icon.png",
    "armory":             "armory_icon.png",
    "quarry":             "quarry_icon.png",

    # ── Resources ───────────────────────────────────────────────────────
    "food":               "res_food.png",
    "berries":            "berry_bush_icon.png",
    "berry":              "berry_bush_icon.png",
    "hunt":               "great_hunt_icon.png",
    "hunting":            "great_hunt_icon.png",
    "wood":               "res_wood_2.png",
    "gold":               "res_gold.png",
    "favor":              "res_favor.png",
    "favour":             "res_favor.png",

    # ── Units ───────────────────────────────────────────────────────────
    "villagers":          "unit_type_villager.png",
    "villager":           "unit_type_villager.png",
    "vills":              "unit_type_villager.png",
    "vils":               "unit_type_villager.png",
    "vill":               "unit_type_villager.png",
    "vil":                "unit_type_villager.png",
    "miko":               "miko_icon.png",
    "pegasus":            "pegasus_icon.png",
    "pioneer":            "pioneer_icon.png",
    "oracle":             "oracle_icon.png",
    "pharaoh":            "pharaoh_icon.png",
}

# Words the auto-scan must NEVER iconize (common verbs/instruction words that
# happen to collide with icon filenames). Curated entries are unaffected.
BLOCKLIST = {
    "build", "move", "option", "military", "back", "then", "next", "send",
    "research", "menu", "add", "background", "base", "off", "on", "blank",
    "main", "top", "left", "right", "up", "down", "arrow", "frame", "list",
    "window", "fill", "cover", "default", "hover", "hovered", "locked",
    "small", "large", "new", "all", "age", "time", "timer", "team", "win",
    "loss", "stop", "start", "wall", "attack", "defend", "free", "first",
}

# Prefixes/suffixes stripped during auto-scan key derivation.
# THE FIX: the old generator only stripped suffixes, but resource icons
# use prefixes (cost_food.png, Icon_Villager.png) — both are handled now.
STRIP_PREFIXES = ("cost_", "cur_", "icon_", "unit_type_", "command_build_",
                  "command_", "menu_bar_fill_", "send_")
STRIP_SUFFIXES = ("_icon", "_active", "_controller", "_icon_2", "_2")


def build_icon_index(icons_dir: Path | None) -> dict[str, str]:
    """
    keyword → filename map. Curated entries always win; the auto-scan only
    fills in keywords not already covered.
    If icons_dir is None or missing, only the curated map is used (CI mode
    runs from the repo root, so 'Build Orders/Icons' normally exists).
    """
    index = dict(CURATED)

    if icons_dir and icons_dir.is_dir():
        for f in sorted(icons_dir.glob("*.png")):
            stem = f.stem.lower()
            key = stem
            for p in STRIP_PREFIXES:
                if key.startswith(p):
                    key = key[len(p):]
                    break
            for s in STRIP_SUFFIXES:
                if key.endswith(s):
                    key = key[: -len(s)]
                    break
            key = key.replace("_", " ").strip()
            # Auto-scan never overrides curated/earlier hits or blocked words
            if key and key not in index and key not in BLOCKLIST:
                index[key] = f.name
    return index


# ─────────────────────────────────────────────────────────────────────────────
# Placeholder-safe iconize (two-pass: text → tokens → <img> tags)
# ─────────────────────────────────────────────────────────────────────────────
def iconize(text: str, index: dict[str, str]) -> str:
    """
    Replace keywords with <img> tags using a two-pass placeholder system so a
    substituted filename can never itself be re-matched (the BGEN3→4 bug).
    Longest keyword first; whole-word matching; case-insensitive; implicit
    plural: 'villager' also matches 'villagers' unless the plural form has its
    own entry.
    """
    safe = html.escape(str(text))
    placeholders: dict[str, str] = {}

    # Longest first so "town center" beats "town", "villagers" beats "vill"
    for kw in sorted(index, key=len, reverse=True):
        fname = index[kw]
        token = f"\x00{len(placeholders)}\x00"
        # \b word boundaries; optional trailing s for implicit plural
        pattern = re.compile(
            r"\b" + re.escape(kw) + r"(s)?\b",
            re.IGNORECASE,
        )

        def _sub(m, _t=token):
            return _t

        new = pattern.sub(_sub, safe)
        if new != safe:
            placeholders[token] = (
                f'<img class="ic" src="{ICON_BASE}{fname}" '
                f'alt="{html.escape(kw)}" title="{html.escape(kw)}">'
            )
            safe = new

    for token, tag in placeholders.items():
        safe = safe.replace(token, tag)
    return safe


# ─────────────────────────────────────────────────────────────────────────────
# Excel parsing
# ─────────────────────────────────────────────────────────────────────────────
ALLOC_RE   = re.compile(r"^\s*\d+\s*/\s*\d+\s*/\s*\d+\s*(/\s*\d+\s*)?$")
YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{6,})"
)


def parse_excel(path: Path):
    df = pd.read_excel(path, header=None, dtype=str).fillna("")
    sections: list[dict] = []
    current = None
    video_id = None

    for _, row in df.iterrows():
        a = str(row.get(0, "")).strip()
        b = str(row.get(1, "")).strip() if len(row) > 1 else ""
        c = str(row.get(2, "")).strip() if len(row) > 2 else ""

        # YouTube row → capture id, suppress from table
        yt = YOUTUBE_RE.search(" ".join([a, b, c]))
        if yt:
            video_id = yt.group(1)
            continue

        if not a and not b and not c:
            continue

        if ALLOC_RE.match(a):
            if current is None:
                current = {"title": "", "rows": []}
                sections.append(current)
            current["rows"].append({"alloc": re.sub(r"\s", "", a),
                                    "text": b, "note": c})
        elif a and not ALLOC_RE.match(a):
            # New section header
            current = {"title": a, "rows": []}
            sections.append(current)
            if b or c:
                current["rows"].append({"alloc": "", "text": b, "note": c})
        else:
            # continuation row (no alloc)
            if current is None:
                current = {"title": "", "rows": []}
                sections.append(current)
            current["rows"].append({"alloc": "", "text": b, "note": c})

    return sections, video_id


# ─────────────────────────────────────────────────────────────────────────────
# HTML template
# ─────────────────────────────────────────────────────────────────────────────
CSS = """
:root {
  --bg: #0d1017; --card: #151a23; --card-hover: #1a2030;
  --accent: #ff4655; --white: #f4f6fa; --muted: #8b93a7;
  --border: rgba(255,255,255,0.06);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--white);
  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
  padding: 32px clamp(16px, 5vw, 64px); line-height: 1.5;
}
.page-header {
  display: flex; align-items: center; gap: 24px;
  padding-bottom: 24px; margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.page-header img.logo { width: 84px; height: 84px; object-fit: contain; }
.page-header h1 {
  font-family: 'Rajdhani', 'Inter', sans-serif;
  font-size: clamp(26px, 4vw, 44px); font-weight: 700;
  letter-spacing: 0.01em;
}
.section-title {
  color: var(--accent); font-family: 'Rajdhani', sans-serif;
  font-size: 20px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; margin: 40px 0 14px;
}
.bo-row {
  display: grid; grid-template-columns: 160px 1fr 1fr;
  gap: 24px; align-items: center;
  background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 22px; margin-bottom: 10px;
  animation: rowIn 0.35s ease both;
}
.bo-row:hover { background: var(--card-hover); }
@keyframes rowIn { from { opacity: 0; transform: translateY(6px); }
                   to   { opacity: 1; transform: none; } }
.alloc {
  color: var(--accent); font-family: 'Rajdhani', monospace;
  font-size: 19px; font-weight: 700; letter-spacing: 0.08em;
  white-space: nowrap;
}
.instr { font-size: 16px; }
.note  { font-size: 15px; color: var(--muted); }
img.ic {
  height: 26px; width: auto; vertical-align: middle;
  margin: 0 2px; position: relative; top: -1px;
}
img.age-ic {
  height: 32px; width: auto; vertical-align: middle;
  margin-right: 10px; position: relative; top: -2px;
}
.video-wrap { margin-top: 48px; }
.video-wrap iframe {
  width: 100%; max-width: 920px; aspect-ratio: 16/9;
  border: 1px solid var(--border); border-radius: 12px;
}
@media (max-width: 760px) {
  .bo-row { grid-template-columns: 90px 1fr; }
  .note { grid-column: 1 / -1; }
}
"""

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>{css}</style>
</head>
<body>
<header class="page-header">
  <img class="logo" src="{logo}" alt="DoD" onerror="this.style.display='none'">
  <h1>{title}</h1>
</header>
{body}
{video}
</body>
</html>
"""


def render(title: str, sections, video_id, index) -> str:
    parts = []
    for sec in sections:
        if sec["title"]:
            title_text = html.escape(sec["title"])
            # Check if this section title starts with an age name → add icon
            age_img = ""
            for age_key, age_file in AGE_ICONS.items():
                if sec["title"].lower().startswith(age_key):
                    age_img = (f'<img class="ic age-ic" '
                               f'src="{ICON_BASE}{age_file}" '
                               f'alt="{age_key}" title="{age_key}">')
                    break
            parts.append(
                f'<div class="section-title">{age_img}{title_text}</div>'
            )
        for r in sec["rows"]:
            alloc = html.escape(r["alloc"])
            instr = iconize(r["text"], index) if r["text"] else ""
            note  = iconize(r["note"],  index) if r["note"]  else ""
            parts.append(
                f'<div class="bo-row"><div class="alloc">{alloc}</div>'
                f'<div class="instr">{instr}</div>'
                f'<div class="note">{note}</div></div>'
            )
    video = ""
    if video_id:
        video = (f'<div class="video-wrap"><iframe '
                 f'src="https://www.youtube.com/embed/{video_id}" '
                 f'allowfullscreen loading="lazy"></iframe></div>')
    return PAGE.format(title=html.escape(title), css=CSS,
                       logo=LOGO_URL, body="\n".join(parts), video=video)


# ─────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="Excel file(s) to convert")
    ap.add_argument("--outdir", default="BO", help="Output folder")
    ap.add_argument("--icons-dir", default="Build Orders/Icons",
                    help="Local icons folder for auto-scan keys")
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    index = build_icon_index(Path(args.icons_dir))
    print(f"Icon index: {len(index)} keywords "
          f"({len(CURATED)} curated + {len(index)-len(CURATED)} auto-scanned)")

    for f in args.files:
        path = Path(f)
        if not path.exists():
            print(f"  SKIP (missing): {f}")
            continue
        title = path.stem
        sections, video_id = parse_excel(path)
        html_out = render(title, sections, video_id, index)

        out_html = outdir / f"{title}.html"
        out_html.write_text(html_out, encoding="utf-8")

        out_json = outdir / f"{title}.json"
        out_json.write_text(json.dumps(
            {"title": title, "video": video_id, "sections": sections},
            indent=2), encoding="utf-8")

        print(f"  OK: {out_html}")


if __name__ == "__main__":
    sys.exit(main())
