"""Write the curated Johannesburg Water network dataset used by import-jw-network.js.

The first dataset is a reviewed subset of official Johannesburg Water and Rand Water
pages (reservoirs, direct feeds, and the Palmiet to Sandton supply). It is not a
hydraulic model. Unmatched suburb names are left for the importer's match report.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "api" / "data" / "johannesburg-water" / "network.json"

def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    required = {"sources", "assets", "assetLocalities", "relationships"}
    missing = required - data.keys()
    if missing:
        raise SystemExit(f"network.json is missing {sorted(missing)}")
    print(f"assets {len(data['assets'])} relationships {len(data['relationships'])} locality rows {len(data['assetLocalities'])}")

if __name__ == "__main__":
    main()
