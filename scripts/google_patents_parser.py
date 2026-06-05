#!/usr/bin/env python3
"""Fetch and parse a Google Patents page into compact JSON."""

from __future__ import annotations

import argparse
import json
import re
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen


PATENT_RE = re.compile(r"\b(?:US|USD|WO|EP|JP|KR|CN)\s?[0-9][0-9A-Z,/ -]{4,}\b")


class TextCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self.parts.append(data)


def normalize_space(value: str) -> str:
    return " ".join((value or "").split()).strip()


def normalize_patent(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def uniq(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = normalize_space(value)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def fetch_text(url: str) -> str:
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 PatentLawless/1.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_json_ld(html: str) -> list[dict]:
    blobs = re.findall(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        html,
        flags=re.I | re.S,
    )
    out: list[dict] = []
    for blob in blobs:
        try:
            parsed = json.loads(unescape(blob))
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
        elif isinstance(parsed, list):
            out.extend(item for item in parsed if isinstance(item, dict))
    return out


def strip_text(html: str) -> str:
    collector = TextCollector()
    collector.feed(html)
    return normalize_space(unescape(" ".join(collector.parts)))


def collect_patents(*values: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for value in values:
        for match in PATENT_RE.findall(value or ""):
            normalized = normalize_patent(match)
            if len(normalized) < 6 or normalized in seen:
                continue
            seen.add(normalized)
            found.append(normalized)
    return found


def windows_around_keywords(text: str, keywords: list[str], span: int = 160) -> list[str]:
    lower = text.lower()
    out: list[str] = []
    for keyword in keywords:
        start = 0
        needle = keyword.lower()
        while True:
            idx = lower.find(needle, start)
            if idx < 0:
                break
            lo = max(0, idx - span)
            hi = min(len(text), idx + len(keyword) + span)
            out.append(text[lo:hi])
            start = idx + len(keyword)
    return uniq(out)


def extract_npl_snippets(text: str) -> list[str]:
    patterns = [
        r"[^.]{0,120}first available[^.]{0,180}",
        r"[^.]{0,120}uprightpose\.com[^.]{0,180}",
        r"[^.]{0,120}manual[^.]{0,180}",
        r"[^.]{0,120}user manual[^.]{0,180}",
        r"[^.]{0,120}quick guide[^.]{0,180}",
    ]
    out: list[str] = []
    for pattern in patterns:
        out.extend(re.findall(pattern, text, flags=re.I))
    return uniq(out)


def derive_product_name_hints(npl_snippets: list[str]) -> list[str]:
    hints: list[str] = []
    for snippet in npl_snippets:
        before_first = re.split(r"first available", snippet, flags=re.I)[0]
        for match in re.findall(r"[A-Z][A-Za-z0-9+/-]*(?:\s+[A-Z0-9][A-Za-z0-9+/-]*){0,5}", before_first):
            cleaned = normalize_space(match.strip(" ,.;:-"))
            if cleaned and not re.fullmatch(r"(Google|Patents|PatentCenter|United States)", cleaned):
                hints.append(cleaned)
    return uniq(hints)


def extract_direct_associations(html: str) -> list[str]:
    values = re.findall(r"patent/([A-Z0-9-]+)/en", html, flags=re.I)
    return uniq([normalize_patent(value) for value in values])


def extract_event_titles(text: str) -> list[str]:
    return windows_around_keywords(
        text,
        [
            "publication of",
            "application granted",
            "priority to",
            "assigned to",
            "continuation",
            "divisional",
            "patent/",
        ],
        span=120,
    )


def extract_abstract(html: str, text: str) -> str:
    match = re.search(
        r"<section[^>]+itemprop=[\"']abstract[\"'][^>]*>(.*?)</section>",
        html,
        flags=re.I | re.S,
    )
    if match:
        return normalize_space(strip_text(match.group(1)))
    windows = windows_around_keywords(text, ["Abstract"], span=700)
    return windows[0] if windows else ""


def extract_claim_windows(text: str) -> list[str]:
    windows = windows_around_keywords(
        text,
        [
            "What is claimed is",
            "Claims",
            "1.",
            "claim 1",
            "The invention claimed is",
        ],
        span=900,
    )
    out: list[str] = []
    for window in windows:
        if re.search(r"\b(claim|claimed|comprising|wherein|apparatus|device|system|method)\b", window, flags=re.I):
            out.append(window)
    return uniq(out)[:8]


def extract_legal_status_windows(text: str) -> list[str]:
    return windows_around_keywords(
        text,
        [
            "Status",
            "Active",
            "Anticipated expiration",
            "Application status",
            "Abandoned",
            "Expired",
            "Ceased",
            "Withdrawn",
            "Rejected",
            "Fee status",
        ],
        span=140,
    )[:12]


def extract_mechanism_terms(title: str, abstract: str, claim_windows: list[str]) -> list[str]:
    text = " ".join([title, abstract] + claim_windows)
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", text)
    stop = {
        "according",
        "apparatus",
        "claim",
        "comprising",
        "configured",
        "device",
        "embodiment",
        "invention",
        "method",
        "patent",
        "plurality",
        "present",
        "thereof",
        "wherein",
    }
    counts: dict[str, int] = {}
    for token in tokens:
        key = token.lower().strip("-")
        if key in stop:
            continue
        counts[key] = counts.get(key, 0) + 1
    ranked = sorted(counts, key=lambda key: (-counts[key], key))
    return ranked[:30]


def assignee_names(ld: dict, text: str) -> list[str]:
    assignee = ld.get("assignee", [])
    if not isinstance(assignee, list):
        assignee = [assignee] if assignee else []
    extra = re.findall(r"(?:Current Assignee|Original Assignee)\s+([A-Z][A-Za-z0-9&.,'\- ]{2,80})", text)
    return uniq([str(item) for item in assignee] + extra)


def parse_page(html: str, url: str) -> dict:
    json_ld = extract_json_ld(html)
    text = strip_text(html)
    title_match = re.search(r"<title>(.*?)</title>", html, flags=re.I | re.S)
    title = normalize_space(unescape(title_match.group(1))) if title_match else ""
    ld = json_ld[0] if json_ld else {}
    inventors = ld.get("inventor", []) if isinstance(ld.get("inventor"), list) else []
    direct_associations = [value for value in extract_direct_associations(html) if value not in {"", normalize_patent(url)}]
    event_titles = extract_event_titles(text)
    relation_windows = windows_around_keywords(
        text,
        ["family", "continuation", "divisional", "publication of", "granted", "priority to", "first available"],
    )
    npl_snippets = extract_npl_snippets(text)
    abstract = extract_abstract(html, text)
    claim_windows = extract_claim_windows(text)
    legal_status_windows = extract_legal_status_windows(text)
    payload = {
        "url": url,
        "title": title,
        "abstract": abstract,
        "publication_number": normalize_patent(str(ld.get("publicationNumber", ""))),
        "grant_number": normalize_patent(str(ld.get("grantNumber", ""))),
        "filing_date": ld.get("filingDate", ""),
        "publication_date": ld.get("publicationDate", ""),
        "assignee_current": assignee_names(ld, text),
        "inventors": uniq([str(item) for item in inventors]),
        "direct_associations": direct_associations,
        "counterpart_hints": collect_patents(" ".join(event_titles + relation_windows + direct_associations)),
        "family_mentions": collect_patents(" ".join(relation_windows)),
        "priority_patents": collect_patents(" ".join(windows_around_keywords(text, ["priority to"], span=90))),
        "claim_windows": claim_windows,
        "claim_excerpt": claim_windows[0] if claim_windows else "",
        "legal_status_windows": legal_status_windows,
        "mechanism_terms": extract_mechanism_terms(title, abstract, claim_windows),
        "event_titles": event_titles,
        "relation_windows": relation_windows[:20],
        "npl_snippets": npl_snippets,
        "product_name_hints": derive_product_name_hints(npl_snippets),
        "text_excerpt": text[:5000],
    }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Google Patents URL to fetch.")
    parser.add_argument("--patent", help="Patent identifier to fetch from patents.google.com.")
    parser.add_argument("--html", help="Path to a saved Google Patents HTML file.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.url and not args.patent and not args.html:
        raise SystemExit("Provide --url, --patent, or --html")
    if args.html:
        html_path = Path(args.html)
        url = html_path.as_uri()
        html = html_path.read_text(encoding="utf-8", errors="replace")
    else:
        url = args.url or f"https://patents.google.com/patent/{normalize_patent(args.patent)}/en"
        html = fetch_text(url)
    payload = parse_page(html, url)
    if args.pretty:
        print(json.dumps(payload, indent=2, ensure_ascii=True))
    else:
        print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
