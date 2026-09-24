import { Prisma } from '@prisma/client';

/**
 * How the site names each tracked municipality's utility and how residents reach it, by Municipality.code. Contact lines are
 * only ones the utility publishes in its own posts: a number GridWatch shows is one people will dial.
 * `areas` is how its outages are grouped by place: City Power posts name a service centre (SDC); Tshwane's name neither a
 * service centre nor a depot, so its outages are grouped by the GIS region of the suburbs they affect.
 */
export const UTILITIES = {
  JOHANNESBURG: { utility: 'City Power', short: 'Johannesburg', areas: 'sdc', contact: { phone: '011 490 7484', freephone: '0800 202 925', web: 'citypower.mobi' } },
  TSHWANE: { utility: 'the City of Tshwane', short: 'Tshwane', areas: 'region', contact: { phone: '012 358 9999', freephone: null, web: 'tshwane.gov.za' } },
};

/** The post on X under the account that actually posted it (x.com redirects a wrong handle, so a wrong one still "works" but flashes). */
export const postUrl = (account, externalId) => `https://x.com/${account}/status/${externalId}`;

/** Prisma where-fragment: outages belonging to this municipality (by code). The outage's own municipality, set from the account that opened it. */
export const outageInMunicipality = (code) => (code ? { Municipality: { code: String(code).toUpperCase() } } : {});

/** Raw-SQL condition: a SourcePost (aliased `sp`) was posted by one of this municipality's accounts. TRUE when no municipality is chosen. */
export const postInMunicipalitySql = (code) =>
  code
    ? Prisma.sql`sp."sourceAccount" IN (SELECT sa."displayName" FROM "SourceAccount" sa JOIN "Municipality" m ON m."id" = sa."municipalityId" WHERE m."code" = ${String(code).toUpperCase()})`
    : Prisma.sql`TRUE`;

/** Raw-SQL condition: an Outage (aliased `o`) belongs to this municipality. TRUE when no municipality is chosen. */
export const outageInMunicipalitySql = (code) =>
  code ? Prisma.sql`o."municipalityId" = (SELECT m."id" FROM "Municipality" m WHERE m."code" = ${String(code).toUpperCase()})` : Prisma.sql`TRUE`;
