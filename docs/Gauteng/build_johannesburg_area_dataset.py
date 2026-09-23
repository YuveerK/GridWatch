#!/usr/bin/env python3
"""
Build a City of Johannesburg area dataset directly from the City's public CGIS ArcGIS REST services.

Outputs:
  johannesburg_area_index.csv
  johannesburg_area_index.json
  johannesburg_area_names_by_region.json
  johannesburg_alias_index.json
  johannesburg_raw_townships.geojson
  johannesburg_regions.geojson
  johannesburg_power_supply.geojson          (unless --no-power)
  johannesburg_source_manifest.json
  johannesburg_dataset_summary.json

Usage:
  pip install shapely
  python build_johannesburg_area_dataset.py --out ./johannesburg-output

The canonical locality geometry is the City of Johannesburg's own cadastral TOWNSHIP data.
In Johannesburg CGIS terminology, "township" is a cadastral/planning term and includes many
places residents normally call suburbs, estates, agricultural holdings, township sections,
and extensions.

Each area is spatially assigned to the City's official administrative Region A-G by maximum
polygon overlap. By default the script also enriches each area with City Power/Eskom supply
and City Power depot-area overlaps, which is particularly useful for GridWatch.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    from shapely.geometry import mapping, shape
except ImportError:
    print("Missing dependency: shapely. Install it with: pip install shapely", file=sys.stderr)
    raise


CGIS_CORE = "https://ags.joburg.org.za/server/rest/services/FeatureServices/CGIS_CORE_DATA/FeatureServer"
MAP3 = "https://ags.joburg.org.za/server/rest/services/map3/MapServer"
CITY_SERVICES = "https://ags.joburg.org.za/server/rest/services/CityServices/MapServer"

SOURCES = {
    "regions": {
        "url": f"{CGIS_CORE}/1",
        "description": "Official City of Johannesburg administrative Region polygons (A-G)",
    },
    "township_polygons": {
        "url": f"{MAP3}/15",
        "description": "Proclaimed and Surveyor-General-approved township/suburb polygons with direct names and extension fields",
    },
    "township_lookup": {
        "url": f"{CGIS_CORE}/11",
        "description": "Township-name lookup: base/current name, extension, former name, SG id, land-type code and postal fields",
    },
    "city_power_supply": {
        "url": f"{CITY_SERVICES}/1",
        "description": "City Power areas of supply",
    },
    "eskom_supply": {
        "url": f"{CITY_SERVICES}/2",
        "description": "Eskom areas of supply published in the City Power map service",
    },
    "city_power_depots": {
        "url": f"{CITY_SERVICES}/100",
        "description": "City Power depot/sub-region administrative boundaries",
    },
}

STATUS_BY_CODE = {
    1: "proclaimed",
    2: "sg_approved",
}

REGION_LETTERS = tuple("ABCDEFG")


def _http_json(url: str, *, retries: int = 4, timeout: int = 90) -> Dict[str, Any]:
    req = Request(
        url,
        headers={
            "User-Agent": "GridWatch-Joburg-Area-Builder/1.0",
            "Accept": "application/json,application/geo+json,*/*",
        },
    )
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            if attempt == retries - 1:
                break
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


def arcgis_geojson(layer_url: str, *, where: str = "1=1", page_size: int = 1000) -> List[Dict[str, Any]]:
    """Fetch all ArcGIS feature-layer records as GeoJSON using resultOffset pagination."""
    all_features: List[Dict[str, Any]] = []
    offset = 0

    while True:
        params = {
            "where": where,
            "outFields": "*",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }
        payload = _http_json(f"{layer_url}/query?{urlencode(params)}")
        if "error" in payload:
            raise RuntimeError(f"ArcGIS error from {layer_url}: {payload['error']}")

        features = payload.get("features", [])
        all_features.extend(features)
        if len(features) < page_size:
            break
        offset += len(features)

    return all_features


def arcgis_table(layer_url: str, *, where: str = "1=1", page_size: int = 1000) -> List[Dict[str, Any]]:
    """Fetch all ArcGIS table records using resultOffset pagination."""
    rows: List[Dict[str, Any]] = []
    offset = 0

    while True:
        params = {
            "where": where,
            "outFields": "*",
            "returnGeometry": "false",
            "f": "json",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }
        payload = _http_json(f"{layer_url}/query?{urlencode(params)}")
        if "error" in payload:
            raise RuntimeError(f"ArcGIS error from {layer_url}: {payload['error']}")

        features = payload.get("features", [])
        rows.extend((f.get("attributes") or {}) for f in features)
        if len(features) < page_size:
            break
        offset += len(features)

    return rows


def props_ci(feature: Dict[str, Any]) -> Dict[str, Any]:
    return {str(k).lower(): v for k, v in (feature.get("properties") or {}).items()}


def row_ci(row: Dict[str, Any]) -> Dict[str, Any]:
    return {str(k).lower(): v for k, v in row.items()}


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def round_geojson(geom: Dict[str, Any], places: int = 6) -> Dict[str, Any]:
    """Round a GeoJSON geometry's coordinates in place (6dp ~= 11cm, plenty for a web map)."""
    def walk(node):
        if isinstance(node, (int, float)):
            return round(node, places)
        return [walk(x) for x in node]

    geom["coordinates"] = walk(geom["coordinates"])
    return geom


def safe_geom(feature: Dict[str, Any]):
    geom = shape(feature["geometry"])
    if not geom.is_valid:
        geom = geom.buffer(0)
    return geom


def region_letter(value: Any) -> Optional[str]:
    text = clean_text(value).upper()
    # Handles values such as "A", "Region A", "REGION A".
    m = re.search(r"(?:REGION\s*)?\b([A-G])\b", text)
    return m.group(1) if m else None


def load_regions() -> List[Dict[str, Any]]:
    features = arcgis_geojson(SOURCES["regions"]["url"])
    parsed: List[Dict[str, Any]] = []

    for f in features:
        if not f.get("geometry"):
            continue
        p = props_ci(f)
        letter = region_letter(p.get("region_name"))
        if letter is None:
            # REGION_ID can differ from A-G semantics, so do not guess from it.
            continue
        parsed.append(
            {
                "region": letter,
                "region_name": clean_text(p.get("region_name")) or f"Region {letter}",
                "region_id": p.get("region_id"),
                "geom": safe_geom(f),
            }
        )

    dissolved: List[Dict[str, Any]] = []
    for letter in REGION_LETTERS:
        matches = [r for r in parsed if r["region"] == letter]
        if not matches:
            continue
        geom = matches[0]["geom"]
        for r in matches[1:]:
            geom = geom.union(r["geom"])
        dissolved.append(
            {
                "region": letter,
                "region_name": f"Region {letter}",
                "region_id": matches[0].get("region_id"),
                "geom": geom,
            }
        )

    found = [r["region"] for r in dissolved]
    if found != list(REGION_LETTERS):
        raise RuntimeError(f"Expected Regions A-G, but found: {found}")
    return dissolved


def load_lookup() -> Dict[int, Dict[str, Any]]:
    rows = arcgis_table(SOURCES["township_lookup"]["url"])
    result: Dict[int, Dict[str, Any]] = {}
    for raw in rows:
        r = row_ci(raw)
        key = r.get("town_name_key")
        try:
            key_int = int(key)
        except (TypeError, ValueError):
            continue
        # If duplicate historical rows exist, prefer one carrying a current town description.
        if key_int not in result or clean_text(r.get("town_name_desc")):
            result[key_int] = r
    return result


def overlap_assignment(geom, polygons: List[Dict[str, Any]], key: str) -> Tuple[Optional[str], float, List[str]]:
    """Return max-overlap value, overlap %, and values with >=0.5% overlap."""
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
        pct = (best_area / total * 100.0) if total > 0 else 100.0
        touched = [v for v, a in overlaps if total <= 0 or (a / total) >= 0.005]
        return best, round(pct, 4), touched

    # Boundary/topology fallback.
    pt = geom.representative_point()
    for item in polygons:
        if item["geom"].covers(pt):
            return str(item[key]), 100.0, [str(item[key])]
    return None, 0.0, []


def load_named_polygons(url: str, candidate_fields: Iterable[str], *, prefix: str = "") -> List[Dict[str, Any]]:
    features = arcgis_geojson(url)
    output: List[Dict[str, Any]] = []
    for f in features:
        if not f.get("geometry"):
            continue
        p = props_ci(f)
        name = ""
        for field in candidate_fields:
            name = clean_text(p.get(field.lower()))
            if name:
                break
        if not name:
            name = f"{prefix}{p.get('objectid')}" if prefix else clean_text(p.get("objectid"))
        output.append({"name": name, "props": p, "geom": safe_geom(f), "feature": f})
    return output


def classify_area(name: str, base_name: str, ext: Any) -> str:
    probe = f"{name} {base_name}".upper()
    if re.search(r"\bA\.?\s*H\.?\b|AGRICULTURAL\s+HOLD", probe):
        return "agricultural_holding"
    if re.search(r"\bZONE\s*\d+\b", probe):
        return "township_zone"
    try:
        ext_num = int(ext) if ext is not None else 0
    except (TypeError, ValueError):
        ext_num = 0
    if ext_num > 0 or re.search(r"\bEXT(?:ENSION)?\.?\s*\d+\b", probe):
        return "township_extension"
    if re.search(r"\bESTATE\b", probe):
        return "estate_or_township"
    return "township_or_suburb"


def normalize_status(status_desc: Any, status_code: Any) -> str:
    text = clean_text(status_desc).lower().replace(" ", "_")
    if text:
        return text
    try:
        return STATUS_BY_CODE.get(int(status_code), "unknown")
    except (TypeError, ValueError):
        return "unknown"


def make_aliases(
    canonical: str,
    *,
    base_name: str,
    former_name: str,
    lookup_desc: str,
    extension: Any,
) -> List[str]:
    values = {canonical, base_name, former_name, lookup_desc}
    values = {clean_text(v) for v in values if clean_text(v)}

    try:
        ext_num = int(extension) if extension is not None else 0
    except (TypeError, ValueError):
        ext_num = 0

    # If the source has a base township name plus extension number, preserve common textual forms.
    if base_name and ext_num > 0:
        values.add(f"{base_name} Ext {ext_num}")
        values.add(f"{base_name} Ext. {ext_num}")
        values.add(f"{base_name} Extension {ext_num}")

    extra = set()
    for v in values:
        extra.add(re.sub(r"\bEXTENSION\b", "Ext", v, flags=re.I))
        extra.add(re.sub(r"\bEXT\.?\s*", "Extension ", v, flags=re.I))
        # Johannesburg CGIS uses A.H.; posts frequently omit the punctuation.
        extra.add(re.sub(r"\bA\.?\s*H\.?\b", "AH", v, flags=re.I))
    values |= {clean_text(v) for v in extra if clean_text(v)}

    return sorted(values, key=str.casefold)


def provider_enrichment(geom, city_power, eskom, depots) -> Dict[str, Any]:
    total = geom.area

    def overlap_pct(items: List[Dict[str, Any]]) -> float:
        if total <= 0:
            return 0.0
        area = 0.0
        for item in items:
            other = item["geom"]
            if not geom.intersects(other):
                continue
            try:
                area += geom.intersection(other).area
            except Exception:
                pass
        return round(min(100.0, area / total * 100.0), 4)

    cp_pct = overlap_pct(city_power)
    eskom_pct = overlap_pct(eskom)

    if cp_pct >= 2 and eskom_pct < 2:
        provider = "City Power"
    elif eskom_pct >= 2 and cp_pct < 2:
        provider = "Eskom"
    elif cp_pct >= 2 and eskom_pct >= 2:
        provider = "Mixed/Boundary"
    else:
        provider = "Unknown"

    depot_overlaps: List[Tuple[str, float]] = []
    if total > 0:
        for d in depots:
            if not geom.intersects(d["geom"]):
                continue
            try:
                pct = geom.intersection(d["geom"]).area / total * 100.0
            except Exception:
                pct = 0.0
            if pct >= 0.5:
                depot_overlaps.append((d["name"], pct))
    depot_overlaps.sort(key=lambda x: x[1], reverse=True)

    return {
        "electricity_supply_match": provider,
        "city_power_overlap_pct": cp_pct,
        "eskom_overlap_pct": eskom_pct,
        "primary_city_power_depot": depot_overlaps[0][0] if depot_overlaps else "",
        "city_power_depots_touched": [name for name, _ in depot_overlaps],
    }


def build_records(regions: List[Dict[str, Any]], *, include_power: bool):
    print("Fetching official Johannesburg township/suburb polygons ...", file=sys.stderr)
    features = arcgis_geojson(SOURCES["township_polygons"]["url"])
    print(f"  received {len(features)} raw polygons", file=sys.stderr)

    print("Fetching Johannesburg township-name lookup ...", file=sys.stderr)
    lookup = load_lookup()
    print(f"  received {len(lookup)} lookup rows", file=sys.stderr)

    city_power: List[Dict[str, Any]] = []
    eskom: List[Dict[str, Any]] = []
    depots: List[Dict[str, Any]] = []
    power_geo_features: List[Dict[str, Any]] = []

    if include_power:
        print("Fetching City Power / Eskom supply boundaries ...", file=sys.stderr)
        city_power = load_named_polygons(
            SOURCES["city_power_supply"]["url"], ["depot_name", "utilitynam"], prefix="CityPower-"
        )
        eskom = load_named_polygons(SOURCES["eskom_supply"]["url"], ["name"], prefix="Eskom-")
        depots = load_named_polygons(SOURCES["city_power_depots"]["url"], ["depot_name"], prefix="Depot-")
        print(f"  City Power supply polygons: {len(city_power)}", file=sys.stderr)
        print(f"  Eskom supply polygons: {len(eskom)}", file=sys.stderr)
        print(f"  City Power depot polygons: {len(depots)}", file=sys.stderr)

        for source_name, items in (
            ("city_power_supply", city_power),
            ("eskom_supply", eskom),
            ("city_power_depot", depots),
        ):
            for item in items:
                props = dict(item["feature"].get("properties") or {})
                props["gridwatch_source_layer"] = source_name
                power_geo_features.append(
                    {"type": "Feature", "properties": props, "geometry": mapping(item["geom"])}
                )

    records: List[Dict[str, Any]] = []
    raw_geo: List[Dict[str, Any]] = []

    region_polygons = [{"region": r["region"], "geom": r["geom"]} for r in regions]

    for f in features:
        if not f.get("geometry"):
            continue
        p = props_ci(f)
        geom = safe_geom(f)

        key_raw = p.get("town_name_key")
        try:
            key = int(key_raw) if key_raw is not None else None
        except (TypeError, ValueError):
            key = None
        lu = lookup.get(key, {}) if key is not None else {}

        name = clean_text(p.get("town_name_desc") or lu.get("town_name_desc"))
        base_name = clean_text(p.get("ts_only_name") or lu.get("ts_only_name"))
        extension = p.get("ts_ext") if p.get("ts_ext") is not None else lu.get("ts_ext")
        if not name:
            try:
                ext_num = int(extension) if extension is not None else 0
            except (TypeError, ValueError):
                ext_num = 0
            if base_name:
                name = f"{base_name} Ext. {ext_num}" if ext_num > 0 else base_name
        if not name:
            continue

        region, overlap_pct, touched = overlap_assignment(geom, region_polygons, "region")
        if region is None:
            continue

        former_name = clean_text(lu.get("former_name"))
        lookup_desc = clean_text(lu.get("town_name_desc"))
        tsg_id = clean_text(p.get("tsg_id") or lu.get("tsg_id"))
        status_code = p.get("status_subtype") if p.get("status_subtype") is not None else lu.get("status_subtype")
        status = normalize_status(p.get("status_desc"), status_code)

        record: Dict[str, Any] = {
            "municipality": "City of Johannesburg",
            "region": region,
            "area_name": name,
            "parent_area": base_name if base_name and base_name.casefold() != name.casefold() else "",
            "area_type": classify_area(name, base_name, extension),
            "status": status,
            "town_name_key": key,
            "tsg_id": tsg_id,
            "extension": extension,
            "former_name": former_name,
            "land_type_code": lu.get("land_type_code"),
            "postal_code_delivery": clean_text(lu.get("postal_code_deliv")),
            "postal_code_pobox": clean_text(lu.get("postal_code_pobox")),
            "aliases": make_aliases(
                name,
                base_name=base_name,
                former_name=former_name,
                lookup_desc=lookup_desc,
                extension=extension,
            ),
            "region_overlap_pct": overlap_pct,
            "crosses_region_boundary": len(touched) > 1,
            "regions_touched": touched,
            "source_objectid": p.get("objectid"),
            "_geom": geom,
        }

        if include_power:
            record.update(provider_enrichment(geom, city_power, eskom, depots))

        records.append(record)

        raw_props = dict(f.get("properties") or {})
        raw_props.update(
            {
                "gridwatch_region": region,
                "gridwatch_area_name": name,
                "gridwatch_area_type": record["area_type"],
                "gridwatch_region_overlap_pct": overlap_pct,
                "gridwatch_crosses_region_boundary": len(touched) > 1,
            }
        )
        if include_power:
            raw_props.update(
                {
                    "gridwatch_electricity_supply_match": record["electricity_supply_match"],
                    "gridwatch_primary_city_power_depot": record["primary_city_power_depot"],
                }
            )
        raw_geo.append({"type": "Feature", "properties": raw_props, "geometry": mapping(geom)})

    return records, raw_geo, power_geo_features


def normalize_records(records: List[Dict[str, Any]], *, include_power: bool) -> List[Dict[str, Any]]:
    # Prefer TSG_ID as a stable cadastral identity; otherwise use region + name.
    grouped: Dict[Tuple[str, str], Dict[str, Any]] = {}

    for r in records:
        identity = r["tsg_id"] or r["area_name"].casefold()
        key = (r["region"], identity)
        if key not in grouped:
            g = dict(r)
            g["aliases"] = set(r["aliases"])
            g["source_objectids"] = {str(r["source_objectid"])} if r.get("source_objectid") is not None else set()
            g["regions_touched"] = set(r["regions_touched"])
            if include_power:
                g["city_power_depots_touched"] = set(r.get("city_power_depots_touched", []))
            grouped[key] = g
            continue

        g = grouped[key]
        g["aliases"].update(r["aliases"])
        if r.get("source_objectid") is not None:
            g["source_objectids"].add(str(r["source_objectid"]))
        g["regions_touched"].update(r["regions_touched"])
        g["crosses_region_boundary"] = bool(g["crosses_region_boundary"] or r["crosses_region_boundary"])
        g["_geom"] = g["_geom"].union(r["_geom"])
        if include_power:
            g["city_power_depots_touched"].update(r.get("city_power_depots_touched", []))
            # Keep the record with the stronger provider overlap as the primary annotation.
            if max(r.get("city_power_overlap_pct", 0), r.get("eskom_overlap_pct", 0)) > max(
                g.get("city_power_overlap_pct", 0), g.get("eskom_overlap_pct", 0)
            ):
                for field in (
                    "electricity_supply_match",
                    "city_power_overlap_pct",
                    "eskom_overlap_pct",
                    "primary_city_power_depot",
                ):
                    g[field] = r.get(field)

    # GridWatch treats "X Ext 2" as part of "X", not a separate suburb (see the extension fallback in
    # infrastructure.service.js and the alias-folding in import-coj-geography.js). Give the base area's own
    # shape the same treatment: union in every area whose parent_area names it, so the drawn boundary covers
    # what a resident (or a City Power post) actually means by that suburb, not just its original core erf.
    by_name_region: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for g in grouped.values():
        by_name_region[(g["region"], g["area_name"].casefold())].append(g)
    for g in grouped.values():
        if not g["parent_area"]:
            continue
        for parent in by_name_region.get((g["region"], g["parent_area"].casefold()), []):
            parent["_geom"] = parent["_geom"].union(g["_geom"])

    output: List[Dict[str, Any]] = []
    for g in grouped.values():
        g.pop("source_objectid", None)
        g["aliases"] = sorted(g["aliases"], key=str.casefold)
        g["source_objectids"] = sorted(g["source_objectids"])
        g["regions_touched"] = sorted(g["regions_touched"])
        if include_power:
            g["city_power_depots_touched"] = sorted(g["city_power_depots_touched"], key=str.casefold)
        geom = g.pop("_geom")
        # A point guaranteed to fall inside the (possibly multi-part) merged shape, not just its bounding-box centre.
        point = geom.representative_point()
        g["lat"] = round(point.y, 6)
        g["lon"] = round(point.x, 6)
        # Simplified for a "roughly here" web map, not a cadastral record: keeps the file and the database small.
        simplified = geom.simplify(0.0001, preserve_topology=True)
        g["boundary"] = round_geojson(mapping(simplified))
        output.append(g)

    output.sort(key=lambda x: (x["region"], x["area_name"].casefold(), x["status"]))
    return output


def write_outputs(
    out_dir: Path,
    normalized: List[Dict[str, Any]],
    raw_geo: List[Dict[str, Any]],
    regions: List[Dict[str, Any]],
    power_geo: List[Dict[str, Any]],
    *,
    include_power: bool,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "generated_from": "City of Johannesburg Corporate Geo-Informatics public ArcGIS REST services",
        "region_assignment": "Maximum polygon overlap with the City's official REGION layer",
        "terminology_note": (
            "CoJ CGIS uses 'township' as a cadastral/planning term; this source includes many places "
            "residents would ordinarily call suburbs, extensions, estates and agricultural holdings."
        ),
        "include_power_enrichment": include_power,
        "sources": SOURCES,
        "status_codes": STATUS_BY_CODE,
    }
    (out_dir / "johannesburg_source_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    (out_dir / "johannesburg_area_index.json").write_text(
        json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    by_region: Dict[str, List[str]] = {f"Region {letter}": [] for letter in REGION_LETTERS}
    for r in normalized:
        by_region[f"Region {r['region']}"] .append(r["area_name"])
    for key in by_region:
        by_region[key] = sorted(set(by_region[key]), key=str.casefold)
    (out_dir / "johannesburg_area_names_by_region.json").write_text(
        json.dumps(by_region, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    alias_index: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for r in normalized:
        for alias in r["aliases"]:
            alias_index[alias.casefold()].append(
                {
                    "canonical": r["area_name"],
                    "region": r["region"],
                    "area_type": r["area_type"],
                    "tsg_id": r["tsg_id"],
                }
            )
    alias_index = {k: v for k, v in sorted(alias_index.items(), key=lambda x: x[0])}
    (out_dir / "johannesburg_alias_index.json").write_text(
        json.dumps(alias_index, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    csv_fields = [
        "municipality",
        "region",
        "area_name",
        "parent_area",
        "area_type",
        "lat",
        "lon",
        "status",
        "town_name_key",
        "tsg_id",
        "extension",
        "former_name",
        "land_type_code",
        "postal_code_delivery",
        "postal_code_pobox",
        "aliases",
        "region_overlap_pct",
        "crosses_region_boundary",
        "regions_touched",
        "source_objectids",
    ]
    if include_power:
        csv_fields += [
            "electricity_supply_match",
            "city_power_overlap_pct",
            "eskom_overlap_pct",
            "primary_city_power_depot",
            "city_power_depots_touched",
        ]

    with (out_dir / "johannesburg_area_index.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=csv_fields)
        writer.writeheader()
        for r in normalized:
            row = {k: r.get(k, "") for k in csv_fields}
            row["aliases"] = " | ".join(r["aliases"])
            row["regions_touched"] = " | ".join(r["regions_touched"])
            row["source_objectids"] = " | ".join(r["source_objectids"])
            if include_power:
                row["city_power_depots_touched"] = " | ".join(r.get("city_power_depots_touched", []))
            writer.writerow(row)

    (out_dir / "johannesburg_raw_townships.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": raw_geo}, ensure_ascii=False), encoding="utf-8"
    )

    region_features = []
    for r in regions:
        region_features.append(
            {
                "type": "Feature",
                "properties": {"region": r["region"], "region_name": r["region_name"]},
                "geometry": mapping(r["geom"]),
            }
        )
    (out_dir / "johannesburg_regions.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": region_features}, ensure_ascii=False), encoding="utf-8"
    )

    if include_power:
        (out_dir / "johannesburg_power_supply.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": power_geo}, ensure_ascii=False), encoding="utf-8"
        )

    counts = defaultdict(int)
    type_counts = defaultdict(int)
    provider_counts = defaultdict(int)
    boundary_crossers = 0
    for r in normalized:
        counts[r["region"]] += 1
        type_counts[r["area_type"]] += 1
        boundary_crossers += int(bool(r["crosses_region_boundary"]))
        if include_power:
            provider_counts[r.get("electricity_supply_match", "Unknown")] += 1

    summary: Dict[str, Any] = {
        "total_normalized_records": len(normalized),
        "records_by_region": {f"Region {letter}": counts[letter] for letter in REGION_LETTERS},
        "records_by_area_type": dict(sorted(type_counts.items())),
        "cross_region_boundary_records": boundary_crossers,
        "raw_township_geometry_features": len(raw_geo),
    }
    if include_power:
        summary["records_by_electricity_supply_match"] = dict(sorted(provider_counts.items()))

    (out_dir / "johannesburg_dataset_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2), file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build City of Johannesburg area dataset for GridWatch")
    parser.add_argument("--out", default="./johannesburg-output", help="Output directory")
    parser.add_argument(
        "--no-power",
        action="store_true",
        help="Do not enrich areas with City Power/Eskom supply and City Power depot boundaries.",
    )
    args = parser.parse_args()

    print("Fetching official Johannesburg Region A-G polygons ...", file=sys.stderr)
    regions = load_regions()
    records, raw_geo, power_geo = build_records(regions, include_power=not args.no_power)
    normalized = normalize_records(records, include_power=not args.no_power)
    write_outputs(
        Path(args.out),
        normalized,
        raw_geo,
        regions,
        power_geo,
        include_power=not args.no_power,
    )


if __name__ == "__main__":
    main()
