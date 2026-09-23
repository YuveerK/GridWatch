# GridWatch Gauteng Expansion Research

**Project:** GridWatch  
**Purpose:** Expand power-outage coverage beyond City of Johannesburg to the rest of Gauteng  
**Research date:** 23 September 2026  
**Target consumer:** Claude Code / implementation agent

---

## 1. Current GridWatch Context

GridWatch is a power-outage tracker for Gauteng, South Africa.

Current Johannesburg implementation:

- Reads outage posts from City Power's X/Twitter account: `@CityPowerJhb`
- Extracts affected suburb names and infrastructure references
- Matches names against an official geography database
- Shows live outages on a map
- Johannesburg geography is sourced from City of Johannesburg public ArcGIS/CGIS services
- Johannesburg seed includes:
  - official Regions A–G
  - ~6,000 cadastral township/suburb/extension records
  - aliases / former names
  - City Power and Eskom-related supply-area GIS layers

The goal is to add:

1. City of Tshwane
2. City of Ekurhuleni
3. Emfuleni Local Municipality
4. Midvaal Local Municipality
5. Lesedi Local Municipality
6. Mogale City Local Municipality
7. Rand West City Local Municipality
8. Merafong City Local Municipality

The key implementation requirement is that **municipal geography and electricity supply geography are not always the same thing**. A suburb can lie inside a municipality but be supplied directly by Eskom or, in rare cases, another licensed distributor.

---

# 2. Key Architecture Recommendation

Do not model Gauteng as only:

```text
Municipality
  -> Suburb
```

Use:

```text
Province
└── Municipality
    ├── Municipal region
    ├── Electricity service area
    ├── Electricity depot
    ├── Main place
    │   └── Sub-place
    ├── Township
    │   └── Extension / block / zone
    ├── Informal settlement
    ├── Farm / AH / rural locality
    └── Electricity supplier
```

Maintain a separate electricity-network graph:

```text
Supplier
   ↓
Bulk intake point
   ↓
Substation
   ↓
Switching station
   ↓
Feeder / distributor / cable
   ↓
Affected areas
```

Recommended supplier-confidence enum:

```text
OFFICIAL_NERSA_POLYGON
OFFICIAL_MUNICIPAL_POLYGON
OFFICIAL_MUNICIPAL_AREA_LIST
INFERRED_FROM_NETWORK
INFERRED_FROM_POST
UNKNOWN
```

Important:

> Never treat an Eskom substation, feeder, or upstream fault as proof that affected end customers are direct Eskom customers. Municipal distributors frequently receive bulk supply from Eskom.

---

# 3. Gauteng-Wide Electricity Boundary Problem

## NERSA

NERSA requires licensed electricity distributors to submit their licensed supply areas, including geographic coordinates / polygon information.

This is the ideal long-term source for distinguishing:

- Eskom Distribution
- City Power
- City of Tshwane
- City of Ekurhuleni
- Emfuleni
- Midvaal
- Mogale City
- Rand West City
- Merafong City
- private licensed distributors such as West Rand Power Distributors

However, no convenient public national NERSA GIS REST/WFS/GeoJSON service was located during this research.

Relevant NERSA sources:

- Electricity licence repository:
  - https://www.nersa.org.za/electricity/licences
- NERSA reporting material referencing licensed supply-area coordinates/polygons:
  - https://www.nersa.org.za/file/2032

### Recommendation

Add a future task:

```text
Obtain / request NERSA licensed electricity distribution polygons for Gauteng.
```

If obtained, this should become the authoritative supplier-resolution layer.

---

# 4. City of Tshwane

## 4.1 Outage Communication

### Primary X/Twitter account

**Handle:** `@CityTshwane`

**Confidence:** HIGH

The account posts:

- `#PowerAlert`
- `#PowerUpdate`
- unplanned outage notices
- restoration progress
- estimated restoration times
- feeder / cable / substation references
- affected blocks and suburbs

Typical useful language includes:

```text
main feeder cable
132/11kV substation
W-Substation
cable joints
repairs in progress
estimated restoration time
```

Example X post:

https://x.com/CityTshwane/status/2062154037907132496

Observed affected-area style includes township blocks such as:

```text
Soshanguve Block S
Soshanguve Block T
Soshanguve Block V
```

### Tshwane outage portal

Very important source:

https://powerfailure.tshwane.gov.za/Tshwanesms/Home

This portal exposes live/currently reported power problems and supports very granular locality names.

Examples of naming conventions observed:

```text
PRETORIA GARDENS X02
NELLMAPIUS X04
NELLMAPIUS X08
```

### Recommended GridWatch ingestion

Use both:

```text
@CityTshwane
+
Tshwane Power Failure portal
```

Suggested source roles:

```text
portal -> incident detection / active outage clustering
X      -> narrative, repair details, infrastructure, ETR, restoration
```

---

## 4.2 Official GIS

Tshwane has an excellent public GIS.

### Main GeoWeb basemap

https://e-gis003.tshwane.gov.za/server/rest/services/BaseMaps/GeoWeb_Basemap_WM/MapServer

Useful layer types include:

- Municipal Boundary
- Suburb
- Townships
- AH Townships
- Farm Boundary
- Farm Portions
- Agricultural Holdings
- Erven
- Street Address
- Sectional Schemes

The service distinguishes several cadastral / development types, including registered, unregistered and informal townships.

### Official Regions service

https://e-gis003.tshwane.gov.za/server/rest/services/Other_WS/Regions/MapServer

Use this to spatially assign records to Tshwane Regions 1–7.

### Recommended generation

```text
Suburb / Township / AH / rural polygons
        ↓ spatial intersection
Official Region polygons
        ↓
region = 1..7
```

Do not maintain suburb-to-region relationships manually.

---

## 4.3 Administrative / Electricity Operational Regions

Official municipal planning/service regions:

```text
Region 1
Region 2
Region 3
Region 4
Region 5
Region 6
Region 7
```

Electricity operations also use grouped regional structures, including:

```text
Regions 1 & 2
Region 3
Region 4
Regions 5 & 7
Region 6
```

Known operational/depot references include:

```text
Regions 1 & 2 -> Rosslyn Electricity Depot
Region 3      -> central / Prince's Park-related operations
Region 4      -> Centurion Depot
Regions 5-7   -> Waltloo / central electricity operations
```

Useful City source:

https://www.tshwane.gov.za/?page_id=8940

Electricity/service information:

https://www.tshwane.gov.za/?page_id=546

---

## 4.4 Eskom Boundary

**Confidence that mixed supply exists:** HIGH  
**Confidence in exact public polygon:** LOW

Tshwane explicitly acknowledges that some customers inside the City boundary are directly supplied by Eskom.

The exact current customer-level or polygon-level split was not found in a trustworthy public GIS endpoint.

### Recommendation

Store:

```text
supplier = UNKNOWN
```

unless one of the following exists:

1. NERSA licensed polygon
2. official Tshwane supply-area polygon
3. explicit official Tshwane area list
4. explicit reliable outage/customer notice naming supplier

Do not infer supplier from upstream Eskom infrastructure alone.

---

# 5. City of Ekurhuleni

## 5.1 Outage Communication

### Primary X/Twitter source

**Handle:** `@CoE_Call_Centre`

**Confidence:** HIGH

This is more useful for outages than only following a generic municipal account.

Typical wording:

```text
#CoENoPower in Germiston
```

followed by multiple affected suburbs.

Example post:

https://x.com/CoE_Call_Centre/status/1960935655938093306

Observed affected areas from one outage included:

```text
Malvern East
Wychwood
Primrose Hill
Dania Park
Simmerfield
Primrose
Dawnview
Fisher Hill
Solheim
Wilbart
Meadowbrook
Meadowdale
Sunnyridge
Sunnyrock
Symhurst
Gerdview
```

### Municipal website outage notices

Example:

https://www.ekurhuleni.gov.za/press-releases/service-delivery-interruptions/planned-power-supply-interruption-to-affect-parts-of-benoni/

Useful language includes:

```text
planned power supply interruption
Benoni Bulk substations
Eskom supplied
maintenance
affected neighbourhoods
```

Important: Ekurhuleni sometimes explicitly marks areas as **Eskom supplied** inside outage notices. GridWatch should capture this as a supplier hint with source provenance.

---

## 5.2 Official GIS

Ekurhuleni has excellent public ArcGIS services.

### Property data service

https://gis.ekurhuleni.gov.za/arcgis/rest/services/Ekurhuleni/Ekurhuleni_Propety_Data_Map/MapServer

Known useful layers include:

```text
Addresses                0
Stands                   1
Zoning                   2
Proposed Stands          3
Suburbs                  4
Townships                5
Proposed Townships       6
Farms                    8
Municipal Boundary      11
Municipal Regions       12
Wards                   13
Precinct Boundaries     16
CCC Boundaries          17
```

### Highly useful township boundary FeatureServer

https://gis.ekurhuleni.gov.za/arcgis/rest/services/Hosted/CoE_Budget___IDP_Consultations_FY2526_WFL1/FeatureServer/13

Important fields include:

```text
township
suburb
cca
code
township_code
township_ext
sg_number
water_depot
elec_depot
farm_ptn
township_status
sg_code
```

The `elec_depot` field is particularly valuable for GridWatch.

### Recommended Ekurhuleni area model

```text
suburb
→ township
→ extension
→ municipal region
→ customer care area
→ electricity depot
```

---

## 5.3 Electricity Operational Geography

Do not model only broad municipal North/East/South regions.

The electricity distribution system uses nine service areas:

```text
Alberton
Benoni
Boksburg
Brakpan
Edenvale
Germiston
Kempton Park
Springs / Nigel
Tembisa / Olifantsfontein
```

Broader operational/customer-service regions also commonly appear as:

```text
North
East
South
```

Suggested schema:

```json
{
  "metroRegion": "South",
  "electricityServiceArea": "Germiston",
  "electricityDepot": "...",
  "customerCareArea": "..."
}
```

---

## 5.4 Eskom Boundary

**Confidence mixed supply exists:** HIGH  
**Confidence exact public polygon exists:** LOW/MEDIUM

Official municipal material acknowledges Eskom-supplied areas.

Examples include parts of the Katorus complex.

Municipal outage notices have explicitly identified places such as Wattville as:

```text
Eskom supplied
```

### Recommendation

Treat explicit municipal wording as:

```text
supplierConfidence = OFFICIAL_MUNICIPAL_AREA_LIST
```

but do not generalise nearby suburbs automatically.

---

# 6. Emfuleni Local Municipality

## 6.1 Outage Communication

### X/Twitter

**Handle:** `@EmfuleniLM`

**Confidence:** HIGH

South African government contact-directory material lists the account.

Main website:

https://emfuleni.gov.za/

Typical outage language includes:

```text
EMERGENCY POWER SUPPLY INTERRUPTION
Vanderbijlpark
team dispatched
Munic Substation
Town Substation
no ETR
CW Areas
```

Observed area/asset references include:

```text
Vanderbijlpark
Bonnane
Stephanopark
CW Areas
Munic Substation
Town Substation
```

### Implementation note

Vanderbijlpark uses local sector naming such as:

```text
CW
CE
SE
SW
```

Do not assume conventional suburb names only.

---

## 6.2 Official GIS

No first-party public Emfuleni ArcGIS REST/WFS service comparable with Joburg/Tshwane/Ekurhuleni was located.

Official municipal planning source:

- Emfuleni Spatial Development Framework / Vision 2035
- municipal boundary maps
- ward maps
- area/farm detail maps

Use municipal documents as enrichment.

### Machine-readable fallback

Use the national DPME / Stats SA GIS.

Main service:

https://dpmegis.dpme.gov.za/arcgis/rest/services/Adminboundaries/MapServer/layers

Relevant layers include:

- Local Municipalities
- Main Places
- Sub Places
- Towns
- Settlements
- Farms

Standalone Sub Place FeatureServer:

https://dpmegis.dpme.gov.za/arcgis/rest/services/Hosted/P_Dm_M_Lm_Sp_W_Bound/FeatureServer/0

---

## 6.3 Electricity Operational Geography

No stable public Region 1/2/3 electricity structure was found.

Outage posts appear more asset-centric:

```text
substation
feeder
sector
town
```

Recommended network learning:

```text
substation
→ feeder
→ Vanderbijlpark sector / suburb
```

---

## 6.4 Eskom Boundary

**Confidence:** HIGH at published area-list level

Emfuleni has published municipal licensed-supply areas including:

```text
Vanderbijlpark
Bophelong
Boipatong
Ironsyde
Eatonsyde
Roshnee
Vaaloewer
Sebokeng Hostel
Rust-ter-Vaal
Vereeniging
```

Municipal material states that **Eskom supplies the remaining areas**.

### Recommended seed

For the listed areas:

```text
supplier = EMFULENI
supplierConfidence = OFFICIAL_MUNICIPAL_AREA_LIST
```

For other areas inside Emfuleni:

```text
supplier = ESKOM
supplierConfidence = OFFICIAL_MUNICIPAL_AREA_LIST
```

Before final production use, check for later NERSA licence changes or boundary amendments.

---

# 7. Midvaal Local Municipality

## 7.1 Outage Communication

### X/Twitter

**Handle:** `@MidvaalLM`

**Confidence account exists:** HIGH  
**Confidence it is a consistent structured outage feed:** MEDIUM

### Stronger municipal digital channels

Midvaal promotes:

- MyMidvaal app / digital customer system
- complaints centre
- WhatsApp Virtual Agent
- call centre

WhatsApp Virtual Agent:

```text
081 876 0408
```

Municipal information:

https://www.midvaal.gov.za/midvaal-launches-virtual-agent-automation-to-improve-service-delivery/

### Recommended ingestion priority

```text
1. Midvaal notices / digital service channels
2. @MidvaalLM
3. MyMidvaal / WhatsApp if machine-accessible
```

---

## 7.2 Official GIS

Midvaal has its own ArcGIS Enterprise instance.

Portal REST endpoint:

https://midvaalgis.midvaal.gov.za/portal/sharing/rest/portals/self

The portal exposes a featured ArcGIS group named:

```text
Engineering - Electrical
```

Observed group ID:

```text
18fe3e9fbe094feea97d86cb31fd007a
```

### Important

The underlying public FeatureServer / MapServer items still need to be enumerated and tested.

This is a high-value follow-up because the Electrical group may contain:

- substations
- feeders
- electrical supply areas
- service polygons
- infrastructure

### Status

```text
GIS portal = VERIFIED
specific useful public layers = DISCOVERY INCOMPLETE
```

---

## 7.3 Electricity Operational Geography

No stable numbered region scheme was identified.

Known asset-oriented references include:

```text
M1 Main Substation
Eye of Africa Main Substation
The Grace Substation
```

GridWatch should prioritise substation/network relationships over invented administrative electricity regions.

---

## 7.4 Eskom Boundary

**Confidence on municipal licence-area descriptions:** MEDIUM/HIGH  
**Confidence exact polygon:** LOW

Official Midvaal planning material describes its NERSA-approved municipal supply area as including major areas such as:

```text
Blue Rose City Development
Vaal Marina area
Farm Doornkuil
R59 corridor
Meyerton
Kookrus
Riversdale
Golf Park
Risiville
McKay Estates
Risiville Small Farms / Waldrift
```

### Warning

Do not automatically assign everything outside this descriptive list to Eskom without current NERSA boundary data.

Midvaal/Eskom licensed-supply boundaries have historically had amendments/disputes.

---

# 8. Lesedi Local Municipality

## 8.1 Outage Communication

### X/Twitter

No official Lesedi X account was confidently verified during this research.

**Confidence:** LOW / UNVERIFIED

### Official Facebook

South African government contact listings point to the official Facebook page:

https://www.facebook.com/profile.php?id=100066210115753

Typical outage language observed through indexed copies of official posts includes:

```text
POWER OUTAGE: RENSBURG
fault affecting one of the transformers
technical team conducting tests
```

Other recent location references include:

```text
Jameson Park
R42 plots
farm lines
Ratanda
Obed Nkosi
Ext 23
Ext 26
```

### Ingestion recommendation

Primary:

```text
official Facebook
+
municipal website / notices
```

Do not rely on third-party mirrors as canonical data sources.

---

## 8.2 Official GIS

No public first-party Lesedi ArcGIS REST or WFS endpoint was located.

Use:

```text
DPME / Stats SA Main Place
+
DPME / Stats SA Sub Place
+
Lesedi ward/SDF maps
```

National service:

https://dpmegis.dpme.gov.za/arcgis/rest/services/Adminboundaries/MapServer/layers

---

## 8.3 Electricity Operational Geography

No stable numbered electricity-region scheme was located.

Posts appear asset/location oriented:

```text
Ratanda
Rensburg
Jameson Park
Obed Nkosi
Ext 23
Ext 26
R42 plots
farm lines
transformer
substation
```

---

## 8.4 Eskom Boundary

**Confidence:** LOW

A reliable public area-by-area municipal-vs-Eskom split was not located.

Important:

> Lesedi mentioning an Eskom network fault does not prove affected customers are directly supplied by Eskom.

For now:

```text
supplier = UNKNOWN
supplierConfidence = UNKNOWN
```

until one of these is available:

- NERSA polygon
- official municipal licensed-area map/list
- explicit customer-level municipal notice

---

# 9. Mogale City Local Municipality

## 9.1 Outage Communication

### X/Twitter

No official Mogale City X handle was confidently verified during this research.

**Confidence:** LOW / UNVERIFIED

### Official channels

Government directory points to Mogale City's official Facebook presence.

Municipal website:

https://mogalecity.gov.za/

Municipal service contacts include:

```text
Call centre: 0861 664 253
WhatsApp:    083 787 2814
```

### Recommended ingestion

```text
official Facebook
+
municipal website / public notices
```

---

## 9.2 Official GIS

No public Mogale ArcGIS REST/WFS endpoint comparable to Johannesburg/Tshwane/Ekurhuleni was located.

Mogale publishes useful SDF / precinct material covering areas including:

```text
Muldersdrift
Hekpoort
Magaliesburg
Tarlton
```

Municipal planning/strategy page:

https://mogalecity.gov.za/mogale-city/work-in/strategies/

Use DPME/Stats SA GIS as the machine-readable base.

---

## 9.3 Electricity Operational Geography

No stable numbered electricity-region system was located.

Important infrastructure names in municipal material include:

```text
Condale 33/6.6kV
Azaadville 6.6kV
Factoria
Libertas
Spruit
Leratong
Singqobile
```

These should become GridWatch infrastructure entities.

---

## 9.4 Electricity Supplier Boundary

**Confidence:** HIGH for published area-list split

Mogale is unusual because it has **three** relevant distributors.

### Mogale City municipal supply includes areas such as:

```text
Azaadville
Krugersdorp Central
Burgershoop
Quellerie Park
Munsieville
Monument
Noordheuwel
Wentworth Park
```

### Eskom is responsible for areas including:

```text
Kagiso townships
Swanneville
Rietvallei
Muldersdrift
Tarlton
Hekpoort
Kromdraai
Magaliesburg
```

### West Rand Power Distributors

Private licensed distributor responsible for:

```text
West Village
```

NERSA lists a West Rand Power Distributors distribution licence.

### Recommended supplier enum

```text
MOGALE_CITY
ESKOM
WEST_RAND_POWER_DISTRIBUTORS
```

This municipality must **not** be modelled as one municipality = one electricity utility.

---

# 10. Rand West City Local Municipality

## 10.1 Outage Communication

### X/Twitter

No official X handle was confidently verified.

**Confidence:** LOW / UNVERIFIED

Government directory points primarily to the municipal website.

Municipal website:

https://www.randwestcity.gov.za/

Central contact number:

```text
010 496 5555
```

Municipal outage notices are often reported by local media.

Examples of location/asset wording seen in reported municipal notices:

```text
Wheatlands
Oosterplots
Botha Plots
Elandsvlei
Loumarina
Connie Mulder
Wilbotsdal
Drowel Substation
feeder link cables
```

### Recommendation

Do not use local newspapers as the canonical incident source if a municipal notice can be retrieved directly.

Search for:

- municipal website notices
- customer-service feeds
- official social accounts if later confirmed

---

## 10.2 Official GIS

No public Rand West City ArcGIS REST/WFS endpoint was found.

Use national DPME/Stats SA GIS as base:

https://dpmegis.dpme.gov.za/arcgis/rest/services/Adminboundaries/MapServer/layers

Supplement with:

- Rand West SDF
- municipal ward maps
- service documentation

---

## 10.3 Operational Geography

Rand West City resulted from the merger of:

```text
Randfontein
Westonaria
```

These two legacy footprints still matter operationally and in customer-service references.

Recommended initial representation:

```json
{
  "legacyServiceArea": "RANDFONTEIN"
}
```

or:

```json
{
  "legacyServiceArea": "WESTONARIA"
}
```

Do not hard-code older Region 1 / Region 2 infrastructure groupings as current 2026 operating regions without further verification.

---

## 10.4 Eskom Boundary

**Confidence:** LOW

Eskom participates in upstream/bulk infrastructure and outages, but a reliable customer-level direct-supply split was not located.

Example issue:

```text
Eskom-requested shutdown at Drowel Substation
```

This does **not** prove all customers connected through that outage are direct Eskom customers.

Use:

```text
supplier = UNKNOWN
```

unless a stronger source is found.

Also:

> Do not assume West Rand Power Distributors supplies Rand West City merely because of its name. The confirmed WRPD area found in this research is West Village in Mogale City.

---

# 11. Merafong City Local Municipality

## 11.1 Outage Communication

### X/Twitter

No official Merafong X handle was confidently verified.

**Confidence:** LOW / UNVERIFIED

### Municipal channels

Merafong uses:

```text
WhatsApp:          082 516 0794
Municipal hotline: 018 788 9990
```

The municipality also uses Facebook and WhatsApp for public communication.

Typical outage notice style includes:

```text
Public Notice: Electricity Interruption in Fochville
```

### Recommended ingestion

```text
official Facebook
+
municipal notices
+
WhatsApp only if technically and legally accessible for automation
```

---

## 11.2 Official GIS

Merafong's official website includes a link labelled:

```text
Merafong GIS System
```

Municipal website:

https://merafong.gov.za/

However, the underlying stable public ArcGIS REST/FeatureServer endpoint was not resolved during this research.

### Recommendation

```text
first choice -> discover Merafong GIS backend
fallback     -> DPME/Stats SA polygons
supplement   -> Merafong SDF
```

---

## 11.3 Electricity Operational Geography

No stable numbered electricity-region scheme was found.

Electricity Services is organised functionally around areas such as:

```text
Domestic Metering
Bulk Metering & Power System Protection
Distribution
Electrical Planning
```

Actual outages are more likely to reference:

```text
town
substation
feeder
```

---

## 11.4 Eskom Boundary

**Confidence:** VERY HIGH

Merafong municipal material states:

```text
Khutsong North is the only area within the Municipality that is supplied by Eskom.
```

Municipal Electricity Services is licensed to supply areas including:

```text
Carletonville
portion of Khutsong
Welverdiend
Watersedge
Blybank
Fochville
Kokosi
Wedela
```

### Recommended seed

```json
{
  "area": "Khutsong North",
  "supplier": "ESKOM",
  "supplierConfidence": "OFFICIAL_MUNICIPAL_AREA_LIST"
}
```

Municipal areas listed above:

```text
supplier = MERAFONG_CITY
supplierConfidence = OFFICIAL_MUNICIPAL_AREA_LIST
```

---

# 12. National GIS Fallback for Smaller Gauteng Municipalities

For municipalities without a strong public municipal GIS API, use the South African government's DPME ArcGIS service.

## Main administrative service

https://dpmegis.dpme.gov.za/arcgis/rest/services/Adminboundaries/MapServer/layers

Useful layers:

```text
District Municipalities
Local Municipalities
Towns
Main Places
Sub Places
Settlements
Farms
```

## Sub Place FeatureServer

https://dpmegis.dpme.gov.za/arcgis/rest/services/Hosted/P_Dm_M_Lm_Sp_W_Bound/FeatureServer/0

Use this fallback particularly for:

```text
Emfuleni
Lesedi
Mogale City
Rand West City
Merafong City
```

Store provenance:

```json
{
  "geometrySource": "DPME_STATS_SA"
}
```

so a later municipal dataset can supersede it.

---

# 13. Recommended Municipality Implementation Order

## Tier 1 — Highest-value / easiest

### 1. City of Tshwane

Why:

- active X outage feed
- dedicated outage portal
- excellent municipal GIS
- official Regions 1–7
- detailed township/block naming
- strong infrastructure wording

### 2. City of Ekurhuleni

Why:

- dedicated outage X account
- excellent municipal GIS
- `elec_depot` already stored on township polygons
- nine electricity service areas
- explicit Eskom-supplied wording sometimes appears in notices

These two should be capable of reaching near-Johannesburg data quality.

---

## Tier 2

### 3. Emfuleni

Why:

- verified X account
- useful structured outage wording
- clear published municipal-vs-Eskom licensed-area list
- national GIS sufficient as geography fallback

---

## Tier 3

### 4. Midvaal

Why:

- own ArcGIS Enterprise exists
- Electrical GIS group exists
- good digital channels
- further GIS service discovery required

### 5. Mogale City

Why:

- clear three-supplier structure
- useful municipal area lists
- good candidate for infrastructure learning
- no strong first-party machine-readable GIS located

### 6. Merafong City

Why:

- excellent supplier split
- official GIS front end exists
- outage feed less machine-friendly than Tshwane/Ekurhuleni

---

## Tier 4

### 7. Lesedi

Needs:

- Facebook ingestion
- national GIS fallback
- supplier-boundary research

### 8. Rand West City

Needs:

- better primary outage feed discovery
- national GIS fallback
- supplier-boundary research

---

# 14. Suggested GridWatch Database Model

Example:

```json
{
  "id": "area_123",
  "name": "Malvern East",
  "canonicalName": "Malvern East",
  "aliases": [],
  "province": "Gauteng",
  "municipality": "City of Ekurhuleni",
  "district": null,

  "municipalRegion": "South",
  "electricityServiceArea": "Germiston",
  "electricityDepot": null,
  "customerCareArea": null,

  "mainPlace": null,
  "subPlace": null,
  "township": null,
  "townshipExtension": null,

  "supplier": "CITY_OF_EKURHULENI",
  "supplierConfidence": "UNKNOWN",

  "geometrySource": "CITY_OF_EKURHULENI_GIS",
  "geometry": {}
}
```

Infrastructure entity:

```json
{
  "id": "infra_456",
  "name": "Drowel Substation",
  "canonicalName": "Drowel Substation",
  "type": "SUBSTATION",
  "municipality": "Rand West City",
  "operator": null,
  "aliases": [],
  "coordinates": null,
  "sourceConfidence": "LEARNED_FROM_OFFICIAL_POSTS"
}
```

Infrastructure-to-area relation:

```json
{
  "infrastructureId": "infra_456",
  "areaId": "area_123",
  "relationType": "SUPPLIES",
  "confidence": 0.72,
  "evidenceCount": 8,
  "firstSeenAt": "...",
  "lastSeenAt": "...",
  "sources": []
}
```

---

# 15. Recommended Incident Parser Fields

For every municipal post / notice:

```json
{
  "sourceUtility": "",
  "sourceAccount": "",
  "sourceUrl": "",
  "publishedAt": "",

  "incidentType": "UNPLANNED_OUTAGE",
  "status": "ACTIVE",

  "affectedAreasRaw": [],
  "affectedAreaIds": [],

  "infrastructureRaw": [],
  "infrastructureIds": [],

  "cause": null,
  "repairActivity": null,
  "etr": null,

  "plannedStart": null,
  "plannedEnd": null,

  "supplierHints": [],
  "municipalRegionHints": [],
  "serviceAreaHints": [],
  "depotHints": []
}
```

Suggested incident types:

```text
UNPLANNED_OUTAGE
PLANNED_OUTAGE
RESTORATION_IN_PROGRESS
PARTIALLY_RESTORED
RESTORED
NETWORK_WARNING
LOAD_REDUCTION
LOAD_SHEDDING
UNKNOWN
```

---

# 16. Alias / Locality Learning

Do not mutate official GIS names when GridWatch encounters colloquial names.

Keep separate alias records.

Example:

```json
{
  "alias": "Sosh XX",
  "canonicalArea": "Soshanguve XX",
  "source": "LEARNED_FROM_OUTAGE_POST",
  "confidence": 0.91
}
```

Useful alias types:

```text
ABBREVIATION
FORMER_NAME
COLLOQUIAL_NAME
MISSPELLING
UTILITY_NAME
BLOCK_VARIANT
EXTENSION_VARIANT
OCR_VARIANT
```

Examples:

```text
Ext 4
Ext. 4
Extension 4

Mahikeng
Mafikeng

Sosh XX
Soshanguve XX
```

---

# 17. Utility / Source Registry

Recommended configuration structure:

```json
{
  "CITY_OF_TSHWANE": {
    "municipality": "City of Tshwane",
    "xHandles": ["CityTshwane"],
    "webSources": [
      "https://powerfailure.tshwane.gov.za/Tshwanesms/Home"
    ]
  },

  "CITY_OF_EKURHULENI": {
    "municipality": "City of Ekurhuleni",
    "xHandles": ["CoE_Call_Centre"],
    "webSources": [
      "https://www.ekurhuleni.gov.za/"
    ]
  },

  "EMFULENI": {
    "municipality": "Emfuleni Local Municipality",
    "xHandles": ["EmfuleniLM"],
    "webSources": [
      "https://emfuleni.gov.za/"
    ]
  },

  "MIDVAAL": {
    "municipality": "Midvaal Local Municipality",
    "xHandles": ["MidvaalLM"],
    "webSources": [
      "https://www.midvaal.gov.za/"
    ]
  },

  "LESEDI": {
    "municipality": "Lesedi Local Municipality",
    "xHandles": [],
    "webSources": [
      "https://www.facebook.com/profile.php?id=100066210115753"
    ]
  },

  "MOGALE_CITY": {
    "municipality": "Mogale City Local Municipality",
    "xHandles": [],
    "webSources": [
      "https://mogalecity.gov.za/"
    ]
  },

  "RAND_WEST_CITY": {
    "municipality": "Rand West City Local Municipality",
    "xHandles": [],
    "webSources": [
      "https://www.randwestcity.gov.za/"
    ]
  },

  "MERAFONG_CITY": {
    "municipality": "Merafong City Local Municipality",
    "xHandles": [],
    "webSources": [
      "https://merafong.gov.za/"
    ]
  }
}
```

---

# 18. Confidence Summary

| Municipality | Outage feed | GIS | Ops/service areas | Eskom split |
|---|---|---|---|---|
| City of Tshwane | HIGH | HIGH | HIGH | mixed supply confirmed; exact polygon LOW |
| City of Ekurhuleni | HIGH | HIGH | HIGH | mixed supply confirmed; polygon unresolved |
| Emfuleni | HIGH | MEDIUM | MEDIUM | HIGH area-list confidence |
| Midvaal | MEDIUM | HIGH portal / incomplete service discovery | MEDIUM | MEDIUM/HIGH area-list confidence |
| Lesedi | HIGH Facebook / X unverified | LOW/MEDIUM | MEDIUM | LOW |
| Mogale City | HIGH official non-X channels / X unverified | MEDIUM | MEDIUM | HIGH |
| Rand West City | LOW/MEDIUM | LOW/MEDIUM | MEDIUM | LOW |
| Merafong City | HIGH non-X channels | MEDIUM | MEDIUM | VERY HIGH |

---

# 19. Immediate Claude Code Tasks

## Phase 1 — Tshwane

1. Build ArcGIS downloader for:
   - suburb
   - township
   - AH
   - region polygons
2. Generate canonical Tshwane geography table.
3. Add `@CityTshwane` ingestion.
4. Investigate / parse Tshwane outage portal.
5. Build parser for:
   - Soshanguve blocks
   - Mamelodi extensions
   - substation names
   - feeder/cable language
6. Add infrastructure-learning relationships.

## Phase 2 — Ekurhuleni

1. Download municipal property/geography layers.
2. Query township FeatureServer.
3. Preserve:
   - `suburb`
   - `township`
   - `township_ext`
   - `cca`
   - `elec_depot`
4. Add `@CoE_Call_Centre`.
5. Build nine electricity service-area seed.
6. Record explicit `Eskom supplied` hints from posts/notices.

## Phase 3 — Emfuleni

1. Seed Main Place/Sub Place geometry from DPME.
2. Add `@EmfuleniLM`.
3. Seed official Emfuleni-vs-Eskom supply list.
4. Learn Vanderbijlpark sectors and substations.

## Phase 4 — Remaining municipalities

1. Discover Midvaal Electrical ArcGIS services.
2. Build DPME-based geography for:
   - Lesedi
   - Mogale
   - Rand West
   - Merafong
3. Add supplier seeds for:
   - Mogale
   - Merafong
4. Add Facebook/website notice ingestion.
5. Continue NERSA polygon research.

---

# 20. Important Source URLs

## Tshwane

```text
https://e-gis003.tshwane.gov.za/server/rest/services/BaseMaps/GeoWeb_Basemap_WM/MapServer
https://e-gis003.tshwane.gov.za/server/rest/services/Other_WS/Regions/MapServer
https://powerfailure.tshwane.gov.za/Tshwanesms/Home
https://x.com/CityTshwane
```

## Ekurhuleni

```text
https://gis.ekurhuleni.gov.za/arcgis/rest/services/Ekurhuleni/Ekurhuleni_Propety_Data_Map/MapServer
https://gis.ekurhuleni.gov.za/arcgis/rest/services/Hosted/CoE_Budget___IDP_Consultations_FY2526_WFL1/FeatureServer/13
https://x.com/CoE_Call_Centre
https://www.ekurhuleni.gov.za/
```

## Emfuleni

```text
https://emfuleni.gov.za/
https://x.com/EmfuleniLM
```

## Midvaal

```text
https://midvaalgis.midvaal.gov.za/portal/sharing/rest/portals/self
https://www.midvaal.gov.za/
https://x.com/MidvaalLM
```

## Lesedi

```text
https://www.facebook.com/profile.php?id=100066210115753
```

## Mogale

```text
https://mogalecity.gov.za/
```

## Rand West City

```text
https://www.randwestcity.gov.za/
```

## Merafong

```text
https://merafong.gov.za/
```

## National fallback GIS

```text
https://dpmegis.dpme.gov.za/arcgis/rest/services/Adminboundaries/MapServer/layers
https://dpmegis.dpme.gov.za/arcgis/rest/services/Hosted/P_Dm_M_Lm_Sp_W_Bound/FeatureServer/0
```

## NERSA

```text
https://www.nersa.org.za/electricity/licences
https://www.nersa.org.za/file/2032
```

---

# 21. Final Implementation Principle

GridWatch should separate three concepts:

```text
WHERE IS THIS PLACE?
    -> geography database

WHO RETAILS ELECTRICITY HERE?
    -> licensed supply area

WHAT ELECTRICAL ASSET AFFECTS IT?
    -> learned infrastructure graph
```

Do not merge these into a single field.

For example:

```text
Mogale City municipality
   ≠
Mogale City necessarily supplies electricity
```

because an area can instead be supplied by:

```text
Eskom
West Rand Power Distributors
```

Similarly:

```text
Eskom infrastructure involved in an outage
   ≠
customer is an Eskom direct customer
```

This distinction should remain explicit throughout the GridWatch data model.

---

# 22. Research Gaps Still Worth Resolving

1. Public NERSA licensed-distribution polygon dataset for Gauteng.
2. Exact Tshwane municipal-vs-Eskom customer supply polygon.
3. Exact Ekurhuleni municipal-vs-Eskom customer supply polygon.
4. Full Midvaal `Engineering - Electrical` ArcGIS service discovery.
5. Lesedi direct-supply boundary.
6. Rand West City direct-supply boundary.
7. Stable machine-readable primary outage feeds for:
   - Lesedi
   - Mogale City
   - Rand West City
   - Merafong City
8. Underlying REST endpoint behind Merafong GIS System.
9. Whether any municipality exposes RSS/JSON/API feeds for service interruptions.

These should remain explicit `TODO` items rather than being guessed.

