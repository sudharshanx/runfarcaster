#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Originality check: shared 5-grams and 4-grams between our prose and other published guides.

Competitor text is fetched once into a cache dir (default /workspace/comp/cache; override with
ORIG_CACHE) and reused. Ours: site/src/content/docs/*.mdx, site/src/prompts.ts, site/src/components, site/src/pages/*.astro,
README.md, VOUCHER.md, SECURITY.md. Code blocks, inline code, commands, URLs and HTML/MDX tags are
removed; the words "Farcaster" and "Snapchain read node" act as phrase breaks.

  python3 site/scripts/originality-check.py            # report; exit 1 if any prose 5-gram is shared
  python3 site/scripts/originality-check.py --refresh  # re-download competitor text
"""
import json, os, pathlib, re, sys, urllib.request, html

ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = pathlib.Path(os.environ.get("ORIG_CACHE", "/workspace/comp/cache"))
UA = {"User-Agent": "originality-check/1.0"}

COMPETITORS = {
    "farcaster-in-3": {"sites": ["https://sats100m.github.io/farcaster-in-3/"], "repo": "Sats100M/farcaster-in-3", "spa": False},
    "In Three (P-U-C)": {"sites": ["https://farcaster.permanentupperclass.com/"], "repo": "P-U-C/farcaster-in-three", "spa": True},
    "mohammadma98": {"sites": [], "repo": "mohammadma98/farcaster-snapchain-node-client", "spa": False},
}

def get(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        b = r.read()
    return b if binary else b.decode("utf-8", "replace")

def html_text(s):
    s = re.sub(r"(?is)<(script|style|pre|code)[^>]*>.*?</\1>", " . ", s)
    s = re.sub(r"(?s)<[^>]+>", " . ", s)
    return html.unescape(s)

def js_strings(js):
    out = []
    for m in re.finditer(r'"((?:[^"\\\n]|\\.){12,})"|`((?:[^`\\]|\\.){12,})`|\'((?:[^\'\\\n]|\\.){12,})\'', js):
        t = next(g for g in m.groups() if g is not None)
        if len(t.split()) >= 3 and not re.search(r"[{};=]|=>|function|\bvar\b", t):
            out.append(t)
    return "\n".join(out)

def fetch_competitor(name, cfg):
    d = CACHE / re.sub(r"[^a-z0-9]+", "-", name.lower())
    d.mkdir(parents=True, exist_ok=True)
    texts = {}
    for url in cfg["sites"]:
        try:
            page = get(url)
            texts[url] = html_text(page)
            if cfg["spa"]:
                for src in re.findall(r'<script[^>]+src="([^"]+)"', page):
                    full = urllib.parse.urljoin(url, src)
                    try: texts[full] = js_strings(get(full))
                    except Exception as e: print(f"  warn: {full}: {e}", file=sys.stderr)
            else:  # same-site subpages, one level
                for href in sorted(set(re.findall(r'href="([^"#?]+)"', page)))[:30]:
                    full = urllib.parse.urljoin(url, href)
                    if full.startswith(url) and full != url and not re.search(r"\.(css|js|png|svg|ico|xml|json)$", full):
                        try: texts[full] = html_text(get(full))
                        except Exception: pass
        except Exception as e:
            print(f"  warn: {url}: {e}", file=sys.stderr)
    repo = cfg["repo"]
    try:
        meta = json.loads(get(f"https://api.github.com/repos/{repo}"))
        br = meta["default_branch"]
        tree = json.loads(get(f"https://api.github.com/repos/{repo}/git/trees/{br}?recursive=1"))
        for t in tree.get("tree", []):
            p = t["path"]
            if t["type"] == "blob" and re.search(r"\.(md|mdx|txt)$", p, re.I) and "node_modules" not in p:
                try: texts[f"{repo}:{p}"] = get(f"https://raw.githubusercontent.com/{repo}/{br}/{p}")
                except Exception as e: print(f"  warn: {repo}:{p}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"  warn: repo {repo}: {e}", file=sys.stderr)
    (d / "texts.json").write_text(json.dumps(texts))
    return texts

def load_competitor(name, cfg, refresh):
    f = CACHE / re.sub(r"[^a-z0-9]+", "-", name.lower()) / "texts.json"
    if f.exists() and not refresh:
        return json.loads(f.read_text())
    return fetch_competitor(name, cfg)

CMD = re.compile(r"^\s*(\$ |#|ssh |scp |curl |\./|IP=|export |cd |git |npm |node |hcloud |bash |sudo |CONFIRM=|SSH_|DRY_RUN|read -r|head -c|\d+\. (scp|ssh|curl|\./)|In parallel:|Step \d\.\s+(ssh|scp|\./))")

def prose(text, kind):
    if kind == "md":
        text = re.sub(r"(?s)^---\n.*?\n---\n", lambda m: "\n".join(re.findall(r"^(?:title|description|tagline):\s*(.*)$", m.group(0), re.M)) + "\n", text)
        text = re.sub(r"(?s)```.*?```", " . ", text)
        text = re.sub(r"(?s)~~~.*?~~~", " . ", text)
        text = re.sub(r"(?m)^import .*$", " ", text)
        text = re.sub(r"(?s)\{/\*.*?\*/\}", " . ", text)       # MDX comments (AUTHOR slots)
        text = re.sub(r"(?s)<!--.*?-->", " . ", text)
        text = re.sub(r"(?s)<pre.*?</pre>", " . ", text)
    if kind == "ts":
        text = "\n".join(re.findall(r"`([^`]*)`", text, re.S)) or text
        text = "\n".join(l for l in text.splitlines() if not CMD.match(l))
    text = re.sub(r"`[^`\n]*`", " . ", text)
    text = re.sub(r"https?://\S+", " . ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\]\([^)]*\)", "]", text)
    text = re.sub(r"(?i)snapchain read nodes?|farcaster", " . ", text)
    return text

def segments(text):
    for seg in re.split(r"[.!?;:\n|()\[\]{}\"]+|\s-\s|\u2014|\u2013", text.lower()):
        w = re.findall(r"[a-z0-9][a-z0-9'\-/]*", seg)
        if w: yield w

def ngrams(text, n):
    g = set()
    for w in segments(text):
        for i in range(len(w) - n + 1):
            g.add(" ".join(w[i:i + n]))
    return g

def ours():
    files = sorted((ROOT / "site/src/content/docs").glob("*.mdx")) + [ROOT / "README.md", ROOT / "VOUCHER.md", ROOT / "SECURITY.md"]
    out = {str(f.relative_to(ROOT)): prose(f.read_text(), "md") for f in files if f.exists()}
    for f in [ROOT / "site/src/prompts.ts", *sorted((ROOT / "site/src/components").glob("*.astro")), *sorted((ROOT / "site/src/pages").glob("*.astro"))]:
        out[str(f.relative_to(ROOT))] = prose(f.read_text(), "ts" if f.suffix == ".ts" else "md")
    return out

def main():
    refresh = "--refresh" in sys.argv
    mine = ours()
    mine5 = {f: ngrams(t, 5) for f, t in mine.items()}
    mine4 = {f: ngrams(t, 4) for f, t in mine.items()}
    total5 = 0
    for name, cfg in COMPETITORS.items():
        texts = load_competitor(name, cfg, refresh)
        words = sum(len(t.split()) for t in texts.values())
        comp = "\n".join(prose(t, "md") for t in texts.values())
        c5, c4 = ngrams(comp, 5), ngrams(comp, 4)
        print(f"== {name}: {len(texts)} sources, ~{words} words")
        hits5 = {f: sorted(g & c5) for f, g in mine5.items() if g & c5}
        hits4 = {f: sorted((g & c4) - {x for y in hits5.get(f, []) for x in [" ".join(y.split()[:4]), " ".join(y.split()[1:])]}) for f, g in mine4.items() if g & c4}
        n5 = sum(len(v) for v in hits5.values()); total5 += n5
        print(f"   shared 5-grams: {n5}")
        for f, v in hits5.items():
            for x in v: print(f"     {f}: \"{x}\"")
        n4 = sum(len(v) for v in hits4.values())
        print(f"   shared 4-grams (not part of a 5-gram above): {n4}")
        for f, v in hits4.items():
            if v: print(f"     {f}: " + "; ".join(f'"{x}"' for x in v))
    print(f"\nTOTAL shared prose 5-grams: {total5}")
    sys.exit(1 if total5 else 0)

if __name__ == "__main__":
    import urllib.parse
    main()
