#!/usr/bin/env python3
"""Draws the README's "How it works" diagram as a vertical SVG in a light and a dark theme.

Usage: python3 scripts/diagrams/how-it-works.py   (writes docs/images/src/how-it-works-{light,dark}.svg;
scripts/diagrams/how-it-works.sh renders them to docs/images/how-it-works-{light,dark}.png)
"""
from pathlib import Path

W, H = 1100, 1290
FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif"
THEMES = {
    "light": dict(bg="#faf9f5", box="#f1f0ff", stroke="#8f8cf4", text="#1f1f1f", muted="#5c5a66", line="#6d6a8a",
                  mod="#8f8cf4", mod_text="#ffffff", out="#eaf6ef", out_stroke="#5fbf8f"),
    "dark": dict(bg="#17161c", box="#26242f", stroke="#8f8cf4", text="#f3f2f8", muted="#b8b6c6", line="#9a98b8",
                 mod="#8f8cf4", mod_text="#17161c", out="#1f2a25", out_stroke="#5fbf8f"),
}


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build(t):
    o = []

    def box(x, y, w, h, title, lines, fill, stroke, ink, sub_ink):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="{fill}" stroke="{stroke}" stroke-width="3"/>')
        n = len(lines)
        block = 36 + n * 34
        top = y + (h - block) / 2
        o.append(f'<text x="{x + w / 2}" y="{top + 30}" text-anchor="middle" font-size="34" font-weight="700" fill="{ink}">{esc(title)}</text>')
        for i, ln in enumerate(lines):
            o.append(f'<text x="{x + w / 2}" y="{top + 30 + 40 + i * 34}" text-anchor="middle" font-size="26" fill="{sub_ink}">{esc(ln)}</text>')

    def arrow(x1, y1, x2, y2):
        o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2 - 12}" stroke="{t["line"]}" stroke-width="4"/>')
        o.append(f'<path d="M{x2 - 11} {y2 - 16} L{x2} {y2} L{x2 + 11} {y2 - 16} Z" fill="{t["line"]}"/>')

    def label(x, y, lines, anchor="start"):
        for i, ln in enumerate(lines):
            o.append(f'<text x="{x}" y="{y + i * 32}" text-anchor="{anchor}" font-size="26" font-weight="600" fill="{t["muted"]}">{esc(ln)}</text>')

    cx = 400  # centre of the main column (x 100..700)
    box(100, 30, 600, 100, "You", [], t["box"], t["stroke"], t["text"], t["muted"])
    arrow(cx, 130, cx, 230)
    label(cx + 24, 188, ["/flowdeck <task>"])

    box(100, 230, 600, 190, "Orchestrator", ["the main session plans,", "designs and reviews"], t["box"], t["stroke"], t["text"], t["muted"])
    arrow(cx, 420, cx, 520)
    label(cx + 24, 478, ["Agent: #n title"])

    box(100, 520, 600, 210, "Worker subagents", ["light, medium, careful, heavy,", "fable (after your approval)"], t["box"], t["stroke"], t["text"], t["muted"])
    arrow(cx, 730, cx, 830)
    label(cx + 24, 788, ["step tool: their own steps"])

    box(100, 830, 600, 140, "flowdeck mod", ["records every task, run and note"], t["mod"], t["mod"], t["mod_text"], t["mod_text"])

    # the orchestrator also reports to the mod: a lane on the right
    lane = 790
    o.append(f'<polyline points="700,325 {lane},325 {lane},900 712,900" fill="none" stroke="{t["line"]}" stroke-width="4"/>')
    o.append(f'<path d="M714 889 L700 900 L714 911 Z" fill="{t["line"]}"/>')
    label(lane + 28, 520, ["progress tool:", "tasks, done,", "notes"])

    # the mod feeds three outputs
    bus = 1030
    o.append(f'<line x1="{cx}" y1="970" x2="{cx}" y2="{bus}" stroke="{t["line"]}" stroke-width="4"/>')
    o.append(f'<line x1="250" y1="{bus}" x2="910" y2="{bus}" stroke="{t["line"]}" stroke-width="4"/>')
    for x in (250, 580, 910):
        arrow(x, bus, x, 1090)
    box(100, 1090, 300, 160, "Band", ["above the prompt"], t["out"], t["out_stroke"], t["text"], t["muted"])
    box(430, 1090, 300, 160, "Side panel", ["context, usage,", "your flows"], t["out"], t["out_stroke"], t["text"], t["muted"])
    box(760, 1090, 300, 160, "Archive", [".claude/flowdeck/"], t["out"], t["out_stroke"], t["text"], t["muted"])

    body = "\n".join(o)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}" role="img" aria-labelledby="t d">\n'
            f'<title id="t">How FlowDeck works</title>\n'
            f'<desc id="d">You run /flowdeck with a task. The orchestrator, the main session, plans and reviews, and delegates each task to worker subagents. The orchestrator reports to the flowdeck mod with the progress tool and the workers report their own steps with the step tool. The mod feeds the band above the prompt, the side panel and the archive files.</desc>\n'
            f'<rect width="{W}" height="{H}" fill="{t["bg"]}"/>\n{body}\n</svg>\n')


def main():
    out = Path(__file__).resolve().parents[2] / "docs" / "images" / "src"
    out.mkdir(parents=True, exist_ok=True)
    for name, theme in THEMES.items():
        (out / f"how-it-works-{name}.svg").write_text(build(theme))
        print(f"wrote {out / f'how-it-works-{name}.svg'}")


if __name__ == "__main__":
    main()
