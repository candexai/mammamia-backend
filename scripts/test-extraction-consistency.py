#!/usr/bin/env python3
"""
Concurrent extraction consistency test.

Tests extract-data against:
  - PYTHON_API_URL (default: https://eleven.candexai.co.in) — direct Python service
  - Optional NODE_API_URL + JWT_TOKEN — mammamia Node /api/v1/automation/extract-data

Usage:
  python scripts/test-extraction-consistency.py
  python scripts/test-extraction-consistency.py 5 1          # concurrency, iterations
  NODE_API_URL=https://your-node/api/v1 JWT_TOKEN=... python scripts/test-extraction-consistency.py

Env:
  PYTHON_API_URL   — Python extract-data host (default eleven.candexai.co.in)
  NODE_API_URL     — Node API base including /api/v1 (optional)
  JWT_TOKEN        — Bearer token for Node route (required when NODE_API_URL is set)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

# App Damiano sheet conversation IDs (deduplicated, commas fixed)
CONVERSATION_IDS: List[str] = list(
    dict.fromkeys(
        [
            "conv_0601kt8v9vs6fkmbeg35zr6pwnza",
            "conv_3901kt8trwn0fa7atryrs6fp2mgf",
            "conv_2601kt8v9zp4egc8thp42qc2fk51",
            "conv_2701kt8vhav8e1ktnkpean7g54v3",
            "conv_6201kt8vrdn0enw8pr8veh0zn1sb",
            "conv_7901kt8vzwtjen8tnp4q3rbnjq79",
            "conv_7901kt8w1v1vep7v5dsxp92wtvds",
            "conv_7701kt8wk3sfekrbfg0krf04qvan",
            "conv_3501kt8wvv6rfd0t2g4z4c2x2bcx",
            "conv_2001kt8xb4dhfa1bdrt13d4wxj65",
            "conv_5201kt8xchxqfbab3e2nw6fx2rfr",
            "conv_3401kt8x8e2re7rb4tmpm69hvk4c",
            "conv_1401kt8xew32f8w8cbqkjhccb8rv",
            "conv_4901kt8xf0vqfwt9qxa4fz6qtgep",
            "conv_4901kt8xeyn1ee2sgq47yem08xhd",
            "conv_3701kt8xhee1f1jrwy790mrejqjq",
            "conv_9201kt8xgz80e8cbmx31hctrda0h",
            "conv_2601kt8xhvqgfqdbp2vbgqz39rd3",
            "conv_2801kt8xq7qbec3se60w5vnsbay5",
            "conv_7901kt8tgdqmfk5rq5b703chpah9",
            "conv_1801kt8thejceq39fnv0zzb666mc",
            "conv_5601kt8tnj3sexb85mjx9n123pkt",
            "conv_9501kt8xw68ffrx93w7xyfvzwqxy",
            "conv_2201kt8y322sey4vtyr9bajb58a3",
            "conv_2101kt8y6jbpf3496evjkyfk4pg3",
            "conv_0801kt8y7x6zej7bn16fr53hepj5",
            "conv_6701kt8y97edeyhrqezr63rs7ees",
            "conv_3701kt8y82jhekfar6n8x3bma62k",
            "conv_0301kt8ybcfcf749ewz5ryp4g6zr",
            "conv_4401kt8yfemme79r7p7wxjzbh2y7",
            "conv_0801kt8yh2tneewb5qkw8wabdvbf",
            "conv_5301kt8ymhycfwk9g8sw8ye0dt1h",
            "conv_9201kt8ynecdf7fbykwn46pfaj5f",
            "conv_5501kt8ytydzfs69b1zxa9294qjt",
            "conv_3901kt8z1ryff8r9g3anssfmw4ec",
            "conv_8001kt8z78n1eynr6yxr7s5kbrvj",
            "conv_5001kt8zd9tfe9192w99k697jcf8",
            "conv_8901kt8zp8mres0radd6ysdjjt9w",
        ]
    )
)

# Invalid ID produced by missing comma in original script (for failure verification)
INVALID_MERGED_ID = "conv_5601kt8tnj3sexb85mjx9n123pktconv_9501kt8xw68ffrx93w7xyfvzwqxy"

EXTRACTION_PAYLOAD = {
    "extraction_prompt": "Extract whether a person booked an appointment or not",
    "json_example": {
        "appointment_booked": False,
        "appointment_date": "",
        "appointment_time": "",
    },
}

CONCURRENCY = 5
NUM_ITERATIONS = 1


def python_api_url() -> str:
    base = (os.environ.get("PYTHON_API_URL") or "https://eleven.candexai.co.in").rstrip("/")
    return f"{base}/api/v1/automation/extract-data"


def node_api_url() -> Optional[str]:
    base = (os.environ.get("NODE_API_URL") or "").rstrip("/")
    if not base:
        return None
    return f"{base}/automation/extract-data"


def headers_for_node() -> Dict[str, str]:
    token = os.environ.get("JWT_TOKEN", "").strip()
    if not token:
        raise ValueError("JWT_TOKEN is required when NODE_API_URL is set")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def parse_booked(result: Dict[str, Any]) -> Optional[bool]:
    voicemail = result.get("voicemail_detected", False)
    if voicemail:
        return None
    extracted = result.get("extracted_data") or {}
    booked = extracted.get("appointment_booked", result.get("appointment_booked"))
    if booked in (True, "True", "true", 1, "1"):
        return True
    if booked in (False, "False", "false", 0, "0"):
        return False
    return False


async def extract_one(
    client: httpx.AsyncClient,
    url: str,
    conversation_id: str,
    headers: Dict[str, str],
    index: int,
    total: int,
    iteration: int,
    label: str,
) -> Dict[str, Any]:
    payload = {"conversation_id": conversation_id, **EXTRACTION_PAYLOAD}
    start = datetime.now()
    try:
        response = await client.post(url, json=payload, headers=headers)
        duration = (datetime.now() - start).total_seconds()
        if response.status_code == 200:
            result = response.json()
            booked = parse_booked(result)
            if booked is None:
                status = "VOICEMAIL"
            elif booked:
                ed = result.get("extracted_data") or {}
                status = f"BOOKED ({ed.get('appointment_date', 'N/A')} {ed.get('appointment_time', 'N/A')})"
            else:
                status = "NOT BOOKED"
            print(f"[{label}][Iter {iteration}][{index}/{total}] {conversation_id}: {status} ({duration:.2f}s)")
            return {
                "conversation_id": conversation_id,
                "success": True,
                "booked": booked,
                "duration": duration,
                "result": result,
                "label": label,
            }
        print(f"[{label}][{index}/{total}] {conversation_id}: HTTP {response.status_code} ({duration:.2f}s)")
        return {
            "conversation_id": conversation_id,
            "success": False,
            "status_code": response.status_code,
            "error": response.text[:500],
            "label": label,
        }
    except Exception as exc:
        print(f"[{label}][{index}/{total}] {conversation_id}: ERROR {exc}")
        return {"conversation_id": conversation_id, "success": False, "error": str(exc), "label": label}


async def run_batch(
    url: str,
    headers: Dict[str, str],
    ids: List[str],
    label: str,
    concurrency: int,
    num_iterations: int,
) -> List[List[Dict[str, Any]]]:
    semaphore = asyncio.Semaphore(concurrency)
    all_results: List[List[Dict[str, Any]]] = []

    async with httpx.AsyncClient(timeout=120.0) as client:

        async def guarded(cid: str, idx: int, iteration: int):
            async with semaphore:
                return await extract_one(client, url, cid, headers, idx, len(ids), iteration, label)

        for iteration in range(1, num_iterations + 1):
            print(f"\n{'─' * 80}\n{label} — ITERATION {iteration}/{num_iterations}\n{'─' * 80}")
            tasks = [guarded(cid, i + 1, iteration) for i, cid in enumerate(ids)]
            all_results.append(await asyncio.gather(*tasks))
    return all_results


def print_summary(label: str, all_results: List[List[Dict[str, Any]]], num_iterations: int) -> None:
    if not all_results:
        return
    per_conv: Dict[str, List[Optional[bool]]] = defaultdict(list)
    for batch in all_results:
        for row in batch:
            if row.get("success"):
                per_conv[row["conversation_id"]].append(row.get("booked"))

    consistent = inconsistent = 0
    for values in per_conv.values():
        valid = [v for v in values if v is not None]
        if not valid:
            continue
        if len(set(valid)) == 1:
            consistent += 1
        else:
            inconsistent += 1

    last = all_results[-1]
    stats = {"success": 0, "booked": 0, "not_booked": 0, "voicemail": 0, "failed": 0}
    for row in last:
        if not row.get("success"):
            stats["failed"] += 1
        elif row.get("booked") is None:
            stats["voicemail"] += 1
            stats["success"] += 1
        elif row.get("booked"):
            stats["booked"] += 1
            stats["success"] += 1
        else:
            stats["not_booked"] += 1
            stats["success"] += 1

    total = consistent + inconsistent
    score = (consistent / total * 100) if total else 0
    print(f"\n{'=' * 80}\n{label} SUMMARY\n{'=' * 80}")
    print(f"Unique conversations: {len(CONVERSATION_IDS)}")
    print(f"Consistency score: {score:.1f}% ({consistent} consistent, {inconsistent} inconsistent)")
    print(f"Last iteration — success: {stats['success']}, booked: {stats['booked']}, "
          f"not_booked: {stats['not_booked']}, failed: {stats['failed']}")


async def verify_invalid_ids() -> None:
    """Previously-failed merged IDs must return HTTP error, not silent 200."""
    url = python_api_url()
    headers = {"Content-Type": "application/json"}
    print(f"\n{'=' * 80}\nVERIFY INVALID IDs (expect non-200)\n{'=' * 80}")
    async with httpx.AsyncClient(timeout=60.0) as client:
        for bad_id in [INVALID_MERGED_ID, "conv_nonexistent_test_id_000"]:
            resp = await client.post(
                url,
                json={"conversation_id": bad_id, **EXTRACTION_PAYLOAD},
                headers=headers,
            )
            ok = resp.status_code != 200
            print(f"  {bad_id}: HTTP {resp.status_code} — {'PASS (error as expected)' if ok else 'FAIL (unexpected 200)'}")


async def main() -> None:
    global CONCURRENCY, NUM_ITERATIONS
    if len(sys.argv) > 1:
        try:
            CONCURRENCY = int(sys.argv[1])
        except ValueError:
            pass
    if len(sys.argv) > 2:
        try:
            NUM_ITERATIONS = int(sys.argv[2])
        except ValueError:
            pass

    print("=" * 80)
    print("EXTRACTION CONSISTENCY TEST")
    print("=" * 80)
    print(f"Python URL: {python_api_url()}")
    node_url = node_api_url()
    if node_url:
        print(f"Node URL:   {node_url}")
    print(f"Conversations: {len(CONVERSATION_IDS)} unique")
    print(f"Concurrency: {CONCURRENCY}, Iterations: {NUM_ITERATIONS}")
    print("=" * 80)

    await verify_invalid_ids()

    py_results = await run_batch(
        python_api_url(),
        {"Content-Type": "application/json"},
        CONVERSATION_IDS,
        "PYTHON",
        CONCURRENCY,
        NUM_ITERATIONS,
    )
    print_summary("PYTHON", py_results, NUM_ITERATIONS)

    if node_url:
        try:
            node_headers = headers_for_node()
            node_results = await run_batch(
                node_url,
                node_headers,
                CONVERSATION_IDS,
                "NODE",
                CONCURRENCY,
                NUM_ITERATIONS,
            )
            print_summary("NODE", node_results, NUM_ITERATIONS)
        except ValueError as exc:
            print(f"\nSkipping Node test: {exc}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = f"consistency_test_results_{timestamp}.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "python_url": python_api_url(),
                "node_url": node_url,
                "conversation_count": len(CONVERSATION_IDS),
                "python_results": py_results,
            },
            fh,
            indent=2,
            default=str,
        )
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    asyncio.run(main())
