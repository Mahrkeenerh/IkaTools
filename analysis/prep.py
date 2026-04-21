#!/usr/bin/env python3
"""Read a full-scan JSON export and emit a slim JSON for the snapshot dashboard.

Usage:
    python3 prep.py <export.json> [out.json]

Output defaults to ./data.json next to this script.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path


WONDER_NAMES = {
    1: "Hephaestus' Forge",
    2: "Hermes' Temple",
    3: "Ares' Stadium",
    4: "Demeter's Garden",
    5: "Athena's Library",
    6: "Hades' Necropolis",
    7: "Poseidon's Temple",
    8: "Colossus",
}


def main():
    if len(sys.argv) < 2:
        print("usage: prep.py <export.json> [out.json]", file=sys.stderr)
        sys.exit(1)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("data.json")

    with src.open() as f:
        data = json.load(f)

    meta = {
        "world": data.get("world"),
        "exportedAt": data.get("exportedAt"),
    }

    player_scores = {}
    for isl in data.get("islands", []):
        for c in isl.get("cities", []):
            oid = c.get("ownerId")
            if not oid or oid in player_scores:
                continue
            sc = c.get("scores") or {}
            player_scores[oid] = {
                "id": oid,
                "name": c.get("ownerName", ""),
                "army": int(sc.get("army", 0) or 0),
                "building": int(sc.get("building", 0) or 0),
                "research": int(sc.get("research", 0) or 0),
                "trader": int(sc.get("trader", 0) or 0),
                "place": int(sc.get("place", 0) or 0),
            }

    # Per-city: townHall level + max level per building type.
    # A city can have multiple slots of the same type (e.g. 3 warehouses);
    # using max treats "most invested of that type" as the representative
    # level. That's the right aggregation for the heatmap/scatter questions.
    cities_out = []
    per_type_levels = defaultdict(list)  # type -> [levels] for violin

    for c in data.get("cities", []):
        type_max = {}
        for b in c.get("buildings", []):
            t = b.get("type")
            lvl = int(b.get("level") or 0)
            if not t or lvl <= 0:
                continue
            if lvl > type_max.get(t, 0):
                type_max[t] = lvl
        if not type_max:
            continue
        th = type_max.get("townHall", 0)
        if th <= 0:
            continue
        cities_out.append({"th": th, "b": type_max})
        for t, lvl in type_max.items():
            per_type_levels[t].append(lvl)

    # Filter out vanishingly rare types (< 30 cities) to keep charts clean.
    rare_cutoff = 30
    common_types = sorted(
        [t for t, ls in per_type_levels.items() if len(ls) >= rare_cutoff],
        key=lambda t: -len(per_type_levels[t]),
    )

    # Wonders: per-island levels so the dashboard can draw full distributions.
    wonder_levels = defaultdict(list)  # wonder → [level per island]
    wonder_cities = defaultdict(int)
    for isl in data.get("islands", []):
        w = isl.get("wonder")
        if w is None:
            continue
        wonder_levels[w].append(int(isl.get("wonderLevel") or 0))
        wonder_cities[w] += len(isl.get("cities") or [])
    wonder_out = []
    for w in sorted(wonder_levels.keys()):
        lvls = wonder_levels[w]
        wonder_out.append({
            "wonder": w,
            "name": WONDER_NAMES.get(w, f"Wonder {w}"),
            "islands": len(lvls),
            "avgLevel": sum(lvls) / len(lvls) if lvls else 0,
            "citiesOnWonderIslands": wonder_cities[w],
            "levels": lvls,
        })

    # Alliance sizes: from queryIndex.allyCityCounts (tag → city count).
    ally_counts = (data.get("queryIndex") or {}).get("allyCityCounts") or {}
    alliance_sizes = sorted(
        [{"tag": t, "cities": n} for t, n in ally_counts.items() if t != "(none)"],
        key=lambda e: -e["cities"],
    )

    # Cities per populated island (exclude 0-city tiles — those are empty sea).
    cities_per_island = [
        int(i.get("cities") or 0)
        for i in (data.get("map") or {}).get("islands", [])
        if (i.get("cities") or 0) > 0
    ]

    slim = {
        "meta": meta,
        "counts": {
            "players": len(player_scores),
            "cities": len(cities_out),
            "alliances": len(alliance_sizes),
            "islandsPopulated": len(cities_per_island),
        },
        "playerScores": list(player_scores.values()),
        "cities": cities_out,
        "buildingTypes": common_types,
        "wonders": wonder_out,
        "alliances": alliance_sizes,
        "citiesPerIsland": cities_per_island,
    }

    with out.open("w") as f:
        json.dump(slim, f, separators=(",", ":"))

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"wrote {out} ({size_mb:.2f} MB)")
    print(f"  players: {slim['counts']['players']}")
    print(f"  cities:  {slim['counts']['cities']}")
    print(f"  alliances: {slim['counts']['alliances']}")
    print(f"  populated islands: {slim['counts']['islandsPopulated']}")
    print(f"  common building types: {len(common_types)}")


if __name__ == "__main__":
    main()
