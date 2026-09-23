# City of Johannesburg area dataset builder for GridWatch

This builder creates a **City of Johannesburg Region A-G locality dataset directly from the City's Corporate Geo-Informatics (CGIS) ArcGIS services**.

It is the Johannesburg equivalent of the Tshwane GIS builder, but it has one major GridWatch advantage: the City also publicly exposes **City Power supply areas, Eskom supply areas, and City Power depot/sub-region boundaries**, so those can be attached to each locality automatically.

## What counts as an "area" in the source?

Johannesburg CGIS uses **TOWNSHIP** as a cadastral/planning term. It does **not** mean only places colloquially described as townships.

The City's township dataset includes many places residents would normally describe as:

- suburbs
- township sections/zones
- extensions
- estates/developments
- agricultural holdings (A.H.)

The script therefore keeps the City's official cadastral name and derives a practical `area_type` for GridWatch.

## Official City of Johannesburg sources

### Administrative regions A-G

`https://ags.joburg.org.za/server/rest/services/FeatureServices/CGIS_CORE_DATA/FeatureServer/1`

Official polygon layer with `REGION_ID` and `REGION_NAME`.

### Township / suburb / extension polygons

`https://ags.joburg.org.za/server/rest/services/map3/MapServer/15`

Layer: **Proclaimed and SG Approved Township Labels**.

Important fields include:

- `TOWN_NAME_KEY`
- `TOWN_NAME_DESC` — full current area name
- `TS_ONLY_NAME` — base/parent township name
- `TS_EXT` — extension number
- `TSG_ID` — Surveyor-General township identifier
- `STATUS_SUBTYPE`
- `STATUS_DESC`

### Township-name lookup and former names

`https://ags.joburg.org.za/server/rest/services/FeatureServices/CGIS_CORE_DATA/FeatureServer/11`

Useful fields include:

- `TOWN_NAME_DESC`
- `TS_ONLY_NAME`
- `TS_EXT`
- `TSG_ID`
- `FORMER_NAME`
- `LAND_TYPE_CODE`
- postal-code fields

`FORMER_NAME` is particularly useful for GridWatch because older names can still appear in posts, addresses and infrastructure references.

### City Power and Eskom geography

City Power areas of supply:

`https://ags.joburg.org.za/server/rest/services/CityServices/MapServer/1`

Eskom areas of supply published by the City:

`https://ags.joburg.org.za/server/rest/services/CityServices/MapServer/2`

City Power depot/sub-region boundaries:

`https://ags.joburg.org.za/server/rest/services/CityServices/MapServer/100`

The City describes the depot layer as the **administrative boundaries of City Power sub-regions**.

## Run it

```bash
pip install shapely
python build_johannesburg_area_dataset.py --out ./johannesburg-output
```

If you only want areas and Regions A-G and do not want electricity-supply enrichment:

```bash
python build_johannesburg_area_dataset.py --out ./johannesburg-output --no-power
```

## Files produced

- `johannesburg_area_index.csv` — database/import friendly master index
- `johannesburg_area_index.json` — same records as JSON
- `johannesburg_area_names_by_region.json` — simple Region A-G name lists
- `johannesburg_alias_index.json` — lower-cased alias → matching canonical area records
- `johannesburg_raw_townships.geojson` — source polygons with derived GridWatch metadata
- `johannesburg_regions.geojson` — official A-G region polygons
- `johannesburg_power_supply.geojson` — City Power, Eskom and depot polygons (unless `--no-power`)
- `johannesburg_source_manifest.json` — source/provenance information
- `johannesburg_dataset_summary.json` — counts by region/type/provider match

## Example GridWatch record

```json
{
  "municipality": "City of Johannesburg",
  "region": "C",
  "area_name": "Example Ext. 4",
  "parent_area": "Example",
  "area_type": "township_extension",
  "status": "proclaimed",
  "tsg_id": "...",
  "former_name": "",
  "aliases": [
    "Example Ext. 4",
    "Example Ext 4",
    "Example Extension 4"
  ],
  "lat": -26.1234,
  "lon": 27.9876,
  "boundary": { "type": "Polygon", "coordinates": [ [ ... ] ] },
  "electricity_supply_match": "City Power",
  "primary_city_power_depot": "...",
  "crosses_region_boundary": false,
  "regions_touched": ["C"]
}
```

## Region assignment

The script does not infer a Region from an area's name. It spatially intersects every area polygon with the official City of Johannesburg Region layer and chooses the Region containing the largest proportion of that polygon.

If a locality genuinely crosses a regional boundary it is retained and marked with:

- `crosses_region_boundary: true`
- `regions_touched: ["...", "..."]`
- `region_overlap_pct`

## Position and shape

Every area also gets:

- `lat` / `lon` — a point guaranteed to fall inside its (possibly multi-part) shape, for placing a dot.
- `boundary` — a simplified GeoJSON geometry (Polygon/MultiPolygon, WGS84) for drawing the actual shape.

For a base suburb/estate, `boundary` is the union of its own cadastral shape with every area whose
`parent_area` names it (its extensions), since GridWatch treats "X Ext 2" as part of "X", not a separate
place — see the alias-folding in `api/scripts/import-coj-geography.js`. An extension's own record still
carries its own individual (smaller) shape, used only if that extension is ever matched to its own existing
locality row rather than folded into its parent.

## Electricity provider matching

When power enrichment is enabled, each locality also gets:

- `electricity_supply_match`
- `city_power_overlap_pct`
- `eskom_overlap_pct`
- `primary_city_power_depot`
- `city_power_depots_touched`

The provider label is a convenience field derived from polygon overlap. Keep the underlying percentages because boundary areas can legitimately overlap more than one supply polygon and source data can change.

## Important limitation: informal settlements and colloquial neighbourhood names

The CGIS Core Data service gives a strong authoritative base for formal cadastral township/suburb geography. The City's public Region map books also depict **informal settlements**, but that informal-settlement layer is not exposed in the same CGIS Core Data service used by this builder.

For GridWatch, treat this dataset as the authoritative base and maintain a separate learned alias/locality table for:

- informal-settlement names not represented in the cadastral layer
- colloquial neighbourhood names
- abbreviations
- misspellings
- infrastructure-linked place names used by City Power in outage notices

Do not overwrite the official canonical area name when GridWatch learns one of these aliases.

## Recommended GridWatch model

Keep official geography and learned language separate:

```text
Municipality
  └── Region
       └── Official cadastral area
            ├── parent/base area
            ├── extension / zone
            ├── former names
            ├── learned aliases
            ├── City Power/Eskom supply match
            ├── City Power depot
            └── infrastructure associations learned from outage posts
```

That makes the dataset useful both for geographic matching and for the infrastructure-learning pipeline you're building into GridWatch.
