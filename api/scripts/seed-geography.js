import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db/prisma.js";
import { normalizeLabel } from "../src/modules/geography/normalization.js";

const inputPath = resolve(process.env.GEOGRAPHY_FILE ?? "data/johannesburg.txt");

if (!existsSync(inputPath)) {
  console.error(`Geography seed not found: ${inputPath}`);
  process.exitCode = 1;
} else {
  try {
    const input = await readFile(inputPath, "utf8");
    const entries = inputPath.toLowerCase().endsWith(".json")
      ? JSON.parse(input)
      : parseRawGeography(input);
    const report = { source: inputPath, regions: 0, localities: 0, aliases: 0, skipped: 0, duplicates: [], collisions: [] };

    for (const regionInput of entries) {
      for (const duplicate of regionInput.duplicates ?? []) report.duplicates.push({ ...duplicate, region: regionInput.code });
      const region = await prisma.region.upsert({
        where: { code: regionInput.code },
        update: { name: regionInput.name },
        create: { code: regionInput.code, name: regionInput.name },
      });
      report.regions += 1;

      for (const [index, localityInput] of (regionInput.localities ?? []).entries()) {
        const name = typeof localityInput === "string" ? localityInput : localityInput.name;
        const aliases = typeof localityInput === "string" ? [] : localityInput.aliases ?? [];
        const normalizedName = normalizeLabel(name);
        if (!name || !normalizedName) {
          report.skipped += 1;
          continue;
        }

        const existing = await prisma.locality.findFirst({
          where: { normalizedName, regionId: { not: region.id } },
          select: { id: true, region: { select: { code: true } } },
        });
        if (existing) {
          report.collisions.push({ name, normalizedName, existingId: existing.id, existingRegion: existing.region.code, region: region.code });
        }

        const locality = await prisma.locality.upsert({
          where: { regionId_normalizedName: { regionId: region.id, normalizedName } },
          update: { canonicalName: name, sourceLabel: name, sourceLine: localityInput.sourceLine ?? index + 1, active: true },
          create: { canonicalName: name, normalizedName, regionId: region.id, sourceLabel: name, sourceLine: localityInput.sourceLine ?? index + 1 },
        });
        report.localities += 1;

        for (const alias of aliases) {
          const normalizedAlias = normalizeLabel(alias);
          if (!normalizedAlias) continue;
          await prisma.localityAlias.upsert({
            where: { localityId_normalizedAlias: { localityId: locality.id, normalizedAlias } },
            update: { alias, source: "seed" },
            create: { localityId: locality.id, alias, normalizedAlias, source: "seed", status: "CONFIRMED" },
          });
          report.aliases += 1;
        }
      }
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The supplied Johannesburg file is a human-maintained text document rather
 * than a strict CSV/JSON file. It mixes one-locality-per-line sections with
 * comma-separated paragraphs (and Region E ward notes). Keep the parser
 * deliberately conservative and retain source line numbers for provenance.
 */
function parseRawGeography(input) {
  const regions = [];
  let current = null;
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (const [lineIndex, rawLine] of lines.entries()) {
    const header = rawLine.replace(/[\u200B\uFEFF]/g, "").match(/^\s*Region\s+([A-G])\b/i);
    if (header) {
      current = { code: header[1].toUpperCase(), name: `Region ${header[1].toUpperCase()}`, localities: [] };
      regions.push(current);
      continue;
    }
    if (!current) continue;

    for (const part of rawLine.split(/[;,]/)) {
      const cleaned = cleanLocality(part);
      if (!cleaned) continue;
      current.localities.push({ name: cleaned, aliases: [], sourceLine: lineIndex + 1 });
    }
  }

  return regions.map((region) => {
    const deduped = dedupeLocalities(region.localities);
    return { ...region, localities: deduped.localities, duplicates: deduped.duplicates };
  });
}

function cleanLocality(value) {
  let name = String(value ?? "")
    .replace(/[\u200B\uFEFF]/g, "")
    .replace(/[â€™]/g, "'")
    .replace(/[â€“â€”]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\-–—]+|[.\-–—]+$/g, "");
  if (!name) return null;

  // Ward annotations and prose in Region E are not locality names.
  name = name.replace(/^\d+\s+(?=[A-Za-z])/, "").replace(/^and\s+/i, "").trim();
  if (/^(ward\s+location|between\b|from\b|n3\s+highway\b|parts?\s+of\b)/i.test(name)) return null;
  if (/^\d+(?:\s*[-/]\s*\d+)?$/.test(name) || name.length < 2) return null;
  if (/\b(?:avenue|street|highway|river)\b/i.test(name) && /\b(?:between|from|to|border|avenue)\b/i.test(name)) return null;
  return name.replace(/[.]+$/g, "").trim();
}

function dedupeLocalities(localities) {
  const seen = new Set();
  const duplicates = [];
  const unique = localities.filter((locality) => {
    const key = normalizeLabel(locality.name);
    if (!key) return false;
    if (seen.has(key)) {
      duplicates.push({ name: locality.name, normalizedName: key, sourceLine: locality.sourceLine });
      return false;
    }
    seen.add(key);
    return true;
  });
  return { localities: unique, duplicates };
}
