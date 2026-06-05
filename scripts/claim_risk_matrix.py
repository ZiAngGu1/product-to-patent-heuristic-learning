#!/usr/bin/env python3
"""Build a compact claim-risk matrix from product features and patent JSON.

The input patent JSON is expected to come from google_patents_parser.py, but the
tool also tolerates small hand-written JSON objects with title/text fields. This
script is intentionally answer-free: it only scores overlap and surfaces bucket
hints for analyst review.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


ACTIVE_WORDS = {"active", "pending", "granted"}
LOW_LEGAL_WORDS = {"abandoned", "ceased", "expired", "withdrawn", "rejected"}
US_PREFIXES = ("US", "USD")


def normalize_space(value: str) -> str:
    return " ".join((value or "").split()).strip()


def normalize_patent(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def words(value: str) -> set[str]:
    stop = {
        "and",
        "apparatus",
        "device",
        "for",
        "from",
        "method",
        "patent",
        "system",
        "that",
        "the",
        "this",
        "with",
    }
    return {
        token.lower()
        for token in re.findall(r"[A-Za-z0-9]+", value or "")
        if len(token) > 2 and token.lower() not in stop
    }


def flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(flatten_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(flatten_text(item) for item in value.values())
    return str(value)


def patent_id(payload: dict[str, Any], fallback: str) -> str:
    for key in ("grant_number", "publication_number", "patent", "id"):
        value = normalize_patent(str(payload.get(key, "")))
        if value:
            return value
    return normalize_patent(Path(fallback).stem)


def status_text(payload: dict[str, Any]) -> str:
    values = []
    for key in ("status", "legal_status", "legal_status_windows", "event_titles", "text_excerpt"):
        values.append(flatten_text(payload.get(key)))
    return normalize_space(" ".join(values))


def jurisdiction_for(patent: str) -> str:
    if patent.startswith("USD"):
        return "US"
    match = re.match(r"([A-Z]{2})", patent)
    return match.group(1) if match else ""


def legal_signal(patent: str, payload: dict[str, Any]) -> str:
    text = status_text(payload).lower()
    has_low = any(word in text for word in LOW_LEGAL_WORDS)
    has_active = any(word in text for word in ACTIVE_WORDS)
    if has_low:
        return "low"
    if has_active:
        return "active_or_pending"
    if patent.startswith(US_PREFIXES):
        return "unknown_us"
    return "unknown_foreign"


def overlap(product_features: list[str], payload: dict[str, Any]) -> tuple[float, list[str]]:
    product_terms = words(" ".join(product_features))
    patent_text = " ".join(
        flatten_text(payload.get(key))
        for key in (
            "title",
            "abstract",
            "claim_excerpt",
            "claim_windows",
            "text_excerpt",
            "mechanism_terms",
        )
    )
    patent_terms = words(patent_text)
    if not product_terms:
        return 0.0, []
    matched = sorted(product_terms & patent_terms)
    return len(matched) / len(product_terms), matched


def bucket_hint(patent: str, score: float, legal: str) -> str:
    jurisdiction = jurisdiction_for(patent)
    if score >= 0.55 and legal != "low" and jurisdiction in {"US", "CN", "JP", "EP", "KR"}:
        return "HIGH_RISK_REVIEW"
    if score >= 0.25:
        return "RELATED_REVIEW"
    return "LOW_REVIEW"


def summarize(payload: dict[str, Any], product_features: list[str], source: str) -> dict[str, Any]:
    patent = patent_id(payload, source)
    score, matched_terms = overlap(product_features, payload)
    legal = legal_signal(patent, payload)
    claim_text = normalize_space(
        flatten_text(payload.get("claim_excerpt"))
        or flatten_text(payload.get("claim_windows"))
        or flatten_text(payload.get("text_excerpt"))
    )
    return {
        "patent": patent,
        "jurisdiction": jurisdiction_for(patent),
        "legal_signal": legal,
        "overlap_score": round(score, 3),
        "matched_product_terms": matched_terms[:20],
        "title": normalize_space(str(payload.get("title", ""))),
        "assignee": payload.get("assignee_current") or payload.get("assignee") or [],
        "bucket_hint": bucket_hint(patent, score, legal),
        "claim_or_text_excerpt": claim_text[:700],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product-feature", action="append", default=[], help="Concrete product feature or structure.")
    parser.add_argument("--patent-json", action="append", default=[], help="Path to parsed patent JSON.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.patent_json:
        raise SystemExit("Provide at least one --patent-json file")
    rows = []
    for file_name in args.patent_json:
        payload = json.loads(Path(file_name).read_text(encoding="utf-8"))
        rows.append(summarize(payload, args.product_feature, file_name))
    rows.sort(key=lambda row: (row["bucket_hint"], -row["overlap_score"], row["patent"]))
    result = {"product_features": args.product_feature, "rows": rows}
    print(json.dumps(result, indent=2 if args.pretty else None, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
