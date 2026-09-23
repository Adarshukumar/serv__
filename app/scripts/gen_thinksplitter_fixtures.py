#!/usr/bin/env python3
"""
gen_thinksplitter_fixtures.py — differential-test fixture generator.

Extracts the REAL ThinkSplitter class out of
`New Upstage Change Logs/upstage_provider.py` by regex (the module cannot be
imported — it needs curl_cffi, which is not installed), executes it, and records
its output for randomized chunk sequences. The TypeScript port is then asserted
against this file, so the port is proven equivalent to the original rather than
to whoever wrote the test's expectations.

    python3 scripts/gen_thinksplitter_fixtures.py
    -> tests/fixtures/thinksplitter.json

Deterministic: fixed seed, so the fixture file is reproducible.
"""
from __future__ import annotations

import json
import random
import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
SRC = APP.parent / "New Upstage Change Logs" / "upstage_provider.py"
OUT = APP / "tests" / "fixtures" / "thinksplitter.json"

SEED = 20260923
CASES = 400


def extract() -> tuple[object, str, str]:
    src = SRC.read_text(encoding="utf-8")
    open_tag = re.search(r'^_OPEN\s*=\s*"(.*)"$', src, re.M).group(1)
    close_tag = re.search(r'^_CLOSE\s*=\s*"(.*)"$', src, re.M).group(1)
    cls = re.search(
        r"^class ThinkSplitter:.*?(?=^# ═|^@dataclass)", src, re.S | re.M
    ).group(0)
    ns: dict = {}
    exec(f"from typing import List, Tuple\n_OPEN={open_tag!r}\n_CLOSE={close_tag!r}\n{cls}", ns)
    return ns["ThinkSplitter"], open_tag, close_tag


def build_chunks(rng: random.Random, open_tag: str, close_tag: str) -> list[str]:
    """Random chunk sequence that deliberately splits tags across boundaries.

    Tags may be UNBALANCED here (a stray close tag, an unclosed open tag). That
    is intentional: the differential test compares the TS port against the Python
    original on whatever the original does, including its literal-text behaviour
    for stray tags.
    """
    alphabet = ["a", "b", " ", ".", "\n", "x", "1", "<", ">", "/"]
    parts: list[str] = []
    for _ in range(rng.randint(1, 6)):
        kind = rng.random()
        if kind < 0.30:
            parts.append(open_tag)
        elif kind < 0.55:
            parts.append(close_tag)
        else:
            parts.append("".join(rng.choice(alphabet) for _ in range(rng.randint(0, 8))))
    return _slice(rng, "".join(parts))


def build_balanced(rng: random.Random, open_tag: str, close_tag: str) -> list[str]:
    """Well-formed input: properly paired <think> blocks, then sliced randomly.

    On THIS family a strong invariant holds exactly — concatenating every emitted
    segment must equal the input with all tags removed, with no text lost or
    duplicated. It does NOT hold for unbalanced input, because the splitter
    correctly emits a stray `</think>` as literal text.
    """
    plain = lambda: "".join(rng.choice("abc .\n1<>") for _ in range(rng.randint(0, 10)))
    blob = ""
    for _ in range(rng.randint(1, 4)):
        blob += plain()
        if rng.random() < 0.7:
            blob += open_tag + plain() + close_tag
    blob += plain()
    return _slice(rng, blob)


def _slice(rng: random.Random, blob: str) -> list[str]:
    if not blob:
        return [""]
    chunks: list[str] = []
    i = 0
    while i < len(blob):
        n = rng.randint(1, 5)
        chunks.append(blob[i : i + n])
        i += n
    return chunks


def main() -> int:
    ThinkSplitter, open_tag, close_tag = extract()
    rng = random.Random(SEED)
    cases = []

    def record(chunks: list[str], do_flush: bool, balanced: bool) -> list:
        s = ThinkSplitter()
        segs = []
        for c in chunks:
            segs += s.feed(c)
        if do_flush:
            segs += s.flush()
        cases.append(
            {
                "chunks": chunks,
                "flush": do_flush,
                "balanced": balanced,
                "expected": [[k, v] for k, v in segs],
            }
        )
        return segs

    # Hand-picked edge cases first (regression anchors).
    for chunks, do_flush in [
        (["hello<thi"], False),
        (["hello<thi", "nk>world"], False),
        (["abc</th"], True),
        (["tail</thi"], True),
        (["before<think>inside</think>after"], True),
        (["A<thi", "nk>reasoning</thi", "nk>B"], True),
        (["x"], True),
        (["<think>dangling"], True),
        ([open_tag], True),
        ([close_tag], True),
        ([""], True),
        ([open_tag[:3], open_tag[3:], "mid", close_tag[:4], close_tag[4:]], True),
        (["a" * 200], True),
        ([open_tag] * 5, True),
        ([close_tag] * 5, True),
    ]:
        record(chunks, do_flush, balanced=False)

    # Unbalanced fuzz — differential only (no invariant; stray tags are literal text).
    for _ in range(CASES):
        record(build_chunks(rng, open_tag, close_tag), rng.random() < 0.7, balanced=False)

    # Balanced fuzz — differential AND the lossless invariant.
    bad = 0
    balanced_n = 0
    for _ in range(CASES):
        chunks = build_balanced(rng, open_tag, close_tag)
        segs = record(chunks, True, balanced=True)
        balanced_n += 1
        joined = "".join(v for _, v in segs)
        stripped = "".join(chunks).replace(open_tag, "").replace(close_tag, "")
        if joined != stripped:
            bad += 1
            if bad <= 3:
                print(f"  INVARIANT FAIL: chunks={chunks!r}\n    joined  ={joined!r}\n    stripped={stripped!r}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "generated_by": "scripts/gen_thinksplitter_fixtures.py",
                "source": str(SRC.relative_to(APP.parent)),
                "note": "Expected values produced by EXECUTING the original Python ThinkSplitter.",
                "seed": SEED,
                "open_tag": open_tag,
                "close_tag": close_tag,
                "cases": cases,
            },
            indent=1,
        ),
        encoding="utf-8",
    )

    print(f"extracted ThinkSplitter: _OPEN={open_tag!r} _CLOSE={close_tag!r}")
    print(f"cases written          : {len(cases)} (15 fixed + {CASES} unbalanced + {balanced_n} balanced)")
    print(f"lossless invariant     : {balanced_n - bad}/{balanced_n} balanced cases passed"
          + ("" if bad == 0 else f"  ({bad} FAILED)"))
    print(f"wrote {OUT.relative_to(APP)}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
