#!/usr/bin/env python3
"""Lint blog posts against the rules in AGENTS.md.

Usage:
    python3 scripts/lint-posts.py                 # lint every post
    python3 scripts/lint-posts.py <slug-or-path>  # lint specific posts
    python3 scripts/lint-posts.py --strict        # warnings also fail the run

Errors exit non-zero. Warnings are printed but do not fail unless --strict.
Standard library only, so it runs anywhere python3 does.
"""
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / "content" / "posts"
ASSET_DIRS = (ROOT / "static", ROOT / "assets")
COVER_SIZE = (1672, 941)
REQUIRED_KEYS = ("title", "date", "description", "tags")

MERMAID_BLOCK = re.compile(r"\{\{<\s*mermaid[^>]*>\}\}(.*?)\{\{<\s*/mermaid\s*>\}\}", re.S)
FENCE = re.compile(r"^(```|~~~).*?^\1\s*$", re.S | re.M)
EDGE_ID = re.compile(r"\b\w+@(?:-->|---|==>|-\.->)")
INTERNAL_LINK = re.compile(r"\]\((/posts/[^)#\s]*)(#[^)\s]*)?\)")
IMAGE_REF = re.compile(r"(/images/[^\s)\"'>]+)")


def split_front_matter(text):
    """Return (front matter, body, line offset of body) for YAML or TOML."""
    for fence in ("---", "+++"):
        if text.startswith(fence):
            end = text.find("\n" + fence, len(fence))
            if end != -1:
                fm = text[len(fence):end]
                body = text[end + len(fence) + 1:]
                return fm, body, fm.count("\n") + 1
    return "", text, 0


def find_asset(ref):
    """Images are served from static/ or processed from assets/."""
    for base in ASSET_DIRS:
        candidate = base / ref.lstrip("/")
        if candidate.is_file():
            return candidate
    return None


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def line_of(text, index, offset=0):
    return text.count("\n", 0, index) + 1 + offset


def lint(path, slugs):
    errors, warnings = [], []
    text = path.read_text(encoding="utf-8")
    fm, body, body_offset = split_front_matter(text)

    def err(line, msg):
        errors.append(f"{path.relative_to(ROOT)}:{line}: {msg}")

    def warn(line, msg):
        warnings.append(f"{path.relative_to(ROOT)}:{line}: {msg}")

    # Front matter
    if not fm:
        err(1, "missing front matter")
    for key in REQUIRED_KEYS:
        if not re.search(rf"^{key}\s*[:=]", fm, re.M):
            err(1, f"front matter is missing '{key}'")
    for tag_list in re.findall(r"^tags\s*[:=]\s*\[(.*?)\]", fm, re.M):
        for tag in re.findall(r"[\"']([^\"']+)[\"']", tag_list):
            if tag != tag.lower() or " " in tag:
                err(1, f"tag '{tag}' should be lowercase and hyphenated")

    cover = re.search(r"^\s*image\s*[:=]\s*[\"']([^\"']+)[\"']", fm, re.M)
    if not cover:
        warn(1, "no cover image in front matter")
    else:
        cover_file = find_asset(cover.group(1))
        if cover_file is None:
            err(1, f"cover image not found in static/ or assets/: {cover.group(1)}")
        elif cover_file.suffix == ".png":
            size = png_size(cover_file)
            if size and size != COVER_SIZE:
                warn(1, f"cover is {size[0]}x{size[1]}, expected {COVER_SIZE[0]}x{COVER_SIZE[1]}")

    # Dashes anywhere in the file
    for i, line in enumerate(text.splitlines(), 1):
        if "\u2014" in line or "\u2013" in line:
            err(i, "em-dash or en-dash found (use a colon, comma, parentheses, or 'to')")

    # Links and images
    if re.search(r"https?://(www\.)?vishctl\.dev/posts/", body):
        for m in re.finditer(r"https?://(www\.)?vishctl\.dev/posts/", body):
            err(line_of(body, m.start(), body_offset), "use a root-relative link (/posts/<slug>/), not a full URL")
    for m in INTERNAL_LINK.finditer(body):
        target = m.group(1)
        slug = target.strip("/").split("/")[-1] if target.strip("/") != "posts" else None
        if slug and slug not in slugs:
            err(line_of(body, m.start(), body_offset), f"internal link to unknown post: {target}")
        elif slug and not target.endswith("/"):
            warn(line_of(body, m.start(), body_offset), f"internal link should end with a slash: {target}")
    for m in IMAGE_REF.finditer(body):
        ref = m.group(1).rstrip(".,")
        if find_asset(ref) is None:
            err(line_of(body, m.start(), body_offset), f"image not found in static/ or assets/: {ref}")

    # Mermaid rules
    for block in MERMAID_BLOCK.finditer(body):
        src = block.group(1)
        start = line_of(body, block.start(1), body_offset)
        lines = src.splitlines()
        first = next((l.strip() for l in lines if l.strip()), "")
        side_by_side = re.match(r"(flowchart|graph)\s+LR", first) and "~~~" in src and "subgraph" in src
        if side_by_side and not re.search(r"^\s*direction\s+(TB|TD)\s*$", src, re.M):
            err(start, "wide subgraphs sit side by side under 'flowchart LR' (use 'flowchart TD' with 'direction LR' inside)")
        for i, line in enumerate(lines):
            if len(EDGE_ID.findall(line)) > 1:
                err(start + i, "more than one animated edge ID on a line (Mermaid v11 syntax error)")
            if '\\"' in line:
                err(start + i, "escaped quote inside a Mermaid label")
            for label in re.findall(r'\["([^"]*)"\]', line):
                if re.search(r"[{}\[\]&]", re.sub(r"&(amp|lt|gt|quot|#\d+);", "", label)):
                    err(start + i, f"special character in Mermaid label: {label!r}")
        declared = set(re.findall(r"\b(\w+)@(?:-->|---|==>|-\.->)", src))
        animated = set(re.findall(r"^\s*(\w+)@\{", src, re.M))
        for edge in sorted(animated - declared):
            err(start, f"edge '{edge}' is animated but never declared")

    # Anatomy
    prose = FENCE.sub("", MERMAID_BLOCK.sub("", body))
    if not re.search(r"^#{2,3} Cheat sheet\s*$", prose, re.M):
        warn(1, "no '## Cheat sheet' section")
    if not re.search(r"\]\(/posts/", body):
        warn(1, "no internal links to related posts")

    return errors, warnings


def main(argv):
    strict = "--strict" in argv
    args = [a for a in argv if not a.startswith("--")]
    all_posts = sorted(POSTS.glob("*.md"))
    slugs = {p.stem for p in all_posts}
    if args:
        targets = []
        for a in args:
            p = Path(a)
            if not p.is_file():
                p = POSTS / (Path(a).stem + ".md")
            if not p.is_file():
                print(f"not found: {a}", file=sys.stderr)
                return 2
            targets.append(p.resolve())
    else:
        targets = all_posts

    total_errors = total_warnings = 0
    for post in targets:
        errors, warnings = lint(post, slugs)
        for line in errors:
            print(f"ERROR  {line}")
        for line in warnings:
            print(f"warn   {line}")
        total_errors += len(errors)
        total_warnings += len(warnings)

    print(f"\n{len(targets)} posts checked: {total_errors} errors, {total_warnings} warnings")
    return 1 if total_errors or (strict and total_warnings) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
