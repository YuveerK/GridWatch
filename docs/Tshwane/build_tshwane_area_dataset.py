#!/usr/bin/env python3
"""
Build a City of Tshwane area dataset from the City's public GeoWeb ArcGIS REST services, in the same shape
as docs/Johannesburg/build_johannesburg_area_dataset.py so api/scripts/import-tshwane-geography.js (a thin
wrapper around api/src/lib/gis-import.js) can consume it identically.

Outputs (into --out):
  tshwane_area_index.json     one record per official area, same shape as johannesburg_area_index.json
  tshwane_area_index.csv
  tshwane_regions.geojson
  tshwane_dataset_summary.json

Usage:
  pip install shapely truststore
  python build_tshwane_area_dataset.py --out ./tshwane-output

Tshwane's GeoWeb basemap repeats the same "Townships"/"AH Townships"/"Suburb" layers once per cartographic
scale band (e.g. ids 14, 28, 45, 73, 98, 133, 166 are all named "Townships"). A `/query` call ignores a
layer's min/maxScale, so they return the same underlying data; this script queries the most detailed band's
copy of each.

Unlike Johannesburg's TOWN_NAME_DESC (which already includes the extension in the full name), Tshwane's
`name` field is always the base name and `extension` is a separate integer. The area's full identity is
built here as "<name> X<extension>" (zero-padded to 2 digits), matching the "X04"/"X54" convention already
visible in the source data's own `geocode` field (e.g. "TRPX54") and in real outage posts ("Nellmapius X04").
Areas with no `extension` (including ones already named distinctly, like Soshanguve's lettered Blocks, which
Tshwane records as their own top-level names rather than as an extension of "Soshanguve") are base areas in
their own right - no different from how a Johannesburg suburb with no Ext number is a base area.

`class_lu_text` distinguishes 'Township' from 'AH_Township' (agricultural holding); there is no equivalent
of Johannesburg's City Power/Eskom supply-area layers, so `electricity_supply_match` is left out entirely -
see GRIDWATCH_GAUTENG_EXPANSION_RESEARCH.md's finding that no reliable Tshwane municipal-vs-Eskom polygon or
list exists yet.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    import truststore

    truststore.inject_into_ssl()  # e-gis003.tshwane.gov.za's cert chain verifies via the OS store but not a bundled one
except ImportError:
    print("Missing dependency: truststore. Install it with: pip install truststore", file=sys.stderr)
    raise

try:
    from shapely.geometry import mapping, shape
except ImportError:
    print("Missing dependency: shapely. Install it with: pip install shapely", file=sys.stderr)
    raise


BASEMAP = "https://e-gis003.tshwane.gov.za/server/rest/services/BaseMaps/GeoWeb_Basemap_WM/MapServer"
REGIONS_SERVICE = "https://e-gis003.tshwane.gov.za/server/rest/services/Other_WS/Regions/MapServer"

SOURCES = {
    "regions": {"url": f"{REGIONS_SERVICE}/2", "description": "Official City of Tshwane Region 1-7 polygons"},
    "townships": {"url": f"{BASEMAP}/166", "description": "Proclaimed/unregistered township polygons (base areas and extensions)"},
    "ah_townships": {"url": f"{BASEMAP}/167", "description": "Agricultural holding township polygons"},
}

REGION_NUMBERS = tuple("1234567")


def _http_json(url: str, *, retries: int = 4, timeout: int = 90) -> Dict[str, Any]:
    req = Request(url, headers={"User-Agent": "GridWatch-Tshwane-Area-Builder/1.0", "Accept": "application/json,application/geo+json,*/*"})
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            if attempt == retries - 1:
                break
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


def arcgis_geojson(layer_url: str, *, where: str = "1=1", page_size: int = 1000) -> List[Dict[str, Any]]:
    all_features: List[Dict[str, Any]] = []
    offset = 0
    while True:
        params = {"where": where, "outFields": "*", "returnGeometry": "true", "outSR": "4326", "f": "geojson", "resultOffset": offset, "resultRecordCount": page_size}
        payload = _http_json(f"{layer_url}/query?{urlencode(params)}")
        if "error" in payload:
            raise RuntimeError(f"ArcGIS error from {layer_url}: {payload['error']}")
        features = payload.get("features", [])
        all_features.extend(features)
        if len(features) < page_size:
            break
        offset += len(features)
    return all_features


def props_ci(feature: Dict[str, Any]) -> Dict[str, Any]:
    return {str(k).lower(): v for k, v in (feature.get("properties") or {}).items()}


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split()).strip()


def title_case(name: str) -> str:
    """Tshwane's names are all-caps ("THERESAPARK", "DIE HOEWES"); title-case for display. Imperfect for
    hyphenated/abbreviation cases ("SOSHANGUVE-EE" -> "Soshanguve-Ee") - a cosmetic limitation, not a matching
    one, since GridWatch matches on the normalized (lower-cased) form regardless of display casing."""
    return " ".join(w.capitalize() for w in clean_text(name).split(" "))


def safe_geom(feature: Dict[str, Any]):
    geom = shape(feature["geometry"])
    if not geom.is_valid:
        geom = geom.buffer(0)
    return geom


def round_geojson(geom: Dict[str, Any], places: int = 6) -> Dict[str, Any]:
    def walk(node):
        if isinstance(node, (int, float)):
            return round(node, places)
        return [walk(x) for x in node]

    geom["coordinates"] = walk(geom["coordinates"])
    return geom


def overlap_assignment(geom, polygons: List[Dict[str, Any]], key: str) -> Tuple[Optional[str], float]:
    total = geom.area
    overlaps: List[Tuple[str, float]] = []
    for item in polygons:
        other = item["geom"]
        if not geom.intersects(other):
            continue
        try:
            area = geom.intersection(other).area
        except Exception:
            area = 0.0
        if area > 0:
            overlaps.append((str(item[key]), area))
    if overlaps:
        overlaps.sort(key=lambda x: x[1], reverse=True)
        best, best_area = overlaps[0]
        return best, round((best_area / total * 100.0) if total > 0 else 100.0, 4)
    pt = geom.representative_point()
    for item in polygons:
        if item["geom"].covers(pt):
            return str(item[key]), 100.0
    return None, 0.0


def make_aliases(name: str, *, extension: Optional[int]) -> List[str]:
    values = {name}
    if extension:
        values |= {f"{name} X{extension:02d}", f"{name} Ext {extension}", f"{name} Ext. {extension}", f"{name} Extension {extension}"}
    return sorted(values, key=str.casefold)


def load_regions() -> List[Dict[str, Any]]:
    features = arcgis_geojson(SOURCES["regions"]["url"])
    regions = []
    for f in features:
        p = props_ci(f)
        m = clean_text(p.get("name"))
        digit = "".join(c for c in m if c.isdigit())
        if digit not in REGION_NUMBERS:
            continue
        regions.append({"region": digit, "region_name": f"Region {digit}", "geom": safe_geom(f)})
    found = sorted((r["region"] for r in regions), key=int)
    if found != list(REGION_NUMBERS):
        raise RuntimeError(f"Expected Regions 1-7, but found: {found}")
    return regions


def load_areas(url: str, area_type_for_class: str) -> List[Dict[str, Any]]:
    features = arcgis_geojson(url)
    out = []
    for f in features:
        p = props_ci(f)
        name = title_case(p.get("name"))
        if not name:
            continue
        try:
            extension = int(p["extension"]) if p.get("extension") not in (None, "") else None
        except (TypeError, ValueError):
            extension = None
        out.append({
            "base_name": name,
            "extension": extension,
            "numkey": clean_text(p.get("numkey")),
            "status": clean_text(p.get("status_lu_text")).lower().replace(" ", "_") or "unknown",
            "area_type_hint": area_type_for_class,
            "geom": safe_geom(f),
        })
    return out


def build_records(regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    print("Fetching Tshwane township polygons ...", file=sys.stderr)
    townships = load_areas(SOURCES["townships"]["url"], "township")
    print(f"  {len(townships)} township records", file=sys.stderr)
    print("Fetching Tshwane agricultural holding polygons ...", file=sys.stderr)
    ah = load_areas(SOURCES["ah_townships"]["url"], "agricultural_holding")
    print(f"  {len(ah)} AH records", file=sys.stderr)

    region_polygons = [{"region": r["region"], "geom": r["geom"]} for r in regions]
    raw = townships + ah

    # Group by (base_name, extension): the source can have duplicate sliver polygons for the same identity.
    grouped: Dict[Tuple[str, Optional[int]], Dict[str, Any]] = {}
    for r in raw:
        key = (r["base_name"], r["extension"])
        if key not in grouped:
            grouped[key] = dict(r)
        else:
            grouped[key]["geom"] = grouped[key]["geom"].union(r["geom"])

    # Union each base area with whatever extension records name it as their base, so the drawn boundary
    # covers what a resident/post means by "Theresapark", not just its original core erf.
    by_base: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for g in grouped.values():
        if g["extension"] is None:
            by_base[g["base_name"]].append(g)
    for g in grouped.values():
        if g["extension"] is not None and g["base_name"] in by_base:
            for base in by_base[g["base_name"]]:
                base["geom"] = base["geom"].union(g["geom"])

    records = []
    for g in grouped.values():
        area_name = f"{g['base_name']} X{g['extension']:02d}" if g["extension"] else g["base_name"]
        region, region_overlap_pct = overlap_assignment(g["geom"], region_polygons, "region")
        if region is None:
            continue
        simplified = g["geom"].simplify(0.0001, preserve_topology=True)
        point = simplified.representative_point()
        records.append({
            "municipality": "City of Tshwane",
            "region": region,
            "area_name": area_name,
            "parent_area": g["base_name"] if g["extension"] else "",
            "area_type": "township_extension" if (g["extension"] and g["area_type_hint"] == "township") else ("agricultural_holding" if g["area_type_hint"] == "agricultural_holding" else "township_or_suburb"),
            "status": g["status"],
            "numkey": g["numkey"],
            "extension": g["extension"] or 0,
            "aliases": make_aliases(area_name, extension=g["extension"]),
            "region_overlap_pct": region_overlap_pct,
            "lat": round(point.y, 6),
            "lon": round(point.x, 6),
            "boundary": round_geojson(mapping(simplified)),
        })
    records.sort(key=lambda r: (r["region"], r["area_name"].casefold()))
    return records


def write_outputs(out_dir: Path, records: List[Dict[str, Any]], regions: List[Dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "tshwane_area_index.json").write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")

    csv_fields = ["municipality", "region", "area_name", "parent_area", "area_type", "lat", "lon", "status", "numkey", "extension", "aliases", "region_overlap_pct"]
    with (out_dir / "tshwane_area_index.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=csv_fields)
        writer.writeheader()
        for r in records:
            row = {k: r.get(k, "") for k in csv_fields}
            row["aliases"] = " | ".join(r["aliases"])
            writer.writerow(row)

    region_features = [{"type": "Feature", "properties": {"region": r["region"], "region_name": r["region_name"]}, "geometry": mapping(r["geom"])} for r in regions]
    (out_dir / "tshwane_regions.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": region_features}, ensure_ascii=False), encoding="utf-8")

    counts = defaultdict(int)
    type_counts = defaultdict(int)
    for r in records:
        counts[r["region"]] += 1
        type_counts[r["area_type"]] += 1
    summary = {
        "total_records": len(records),
        "records_by_region": {f"Region {n}": counts[n] for n in REGION_NUMBERS},
        "records_by_area_type": dict(sorted(type_counts.items())),
    }
    (out_dir / "tshwane_dataset_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2), file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build City of Tshwane area dataset for GridWatch")
    parser.add_argument("--out", default="./tshwane-output", help="Output directory")
    args = parser.parse_args()

    print("Fetching official Tshwane Region 1-7 polygons ...", file=sys.stderr)
    regions = load_regions()
    records = build_records(regions)
    write_outputs(Path(args.out), records, regions)


if __name__ == "__main__":
    main()
