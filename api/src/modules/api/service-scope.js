import { Prisma } from '@prisma/client';

export const SERVICE_TYPES = ['ELECTRICITY', 'WATER'];

/** Omitted service stays electricity so an old client never receives water incidents. */
export function serviceOf(raw) {
  const s = String(raw ?? 'ELECTRICITY').toUpperCase();
  return SERVICE_TYPES.includes(s) ? s : 'ELECTRICITY';
}

export const outageInService = (service) => ({ serviceType: serviceOf(service) });

export const nodeInService = (service) => ({ serviceType: serviceOf(service) });

export const outageInServiceSql = (service) => Prisma.sql`o."serviceType" = ${serviceOf(service)}::"ServiceType"`;

/** Water supply edges. Bypass and backfeed are not treated as ordinary downstream flow. */
export const FLOW_RELATIONS = ['SUPPLIES', 'PUMPS_TO', 'DIRECTLY_SUPPLIES', 'FEEDS', 'PART_OF', 'UPSTREAM_OF'];

export const WATER_ASSET_TYPES = ['WATER_SYSTEM', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'DIRECT_FEED', 'BULK_CONNECTION', 'BULK_METER', 'BOOSTER_STATION', 'TREATMENT_WORKS', 'PRV', 'WATER_PIPELINE', 'WATER_OTHER'];

/** Who the site quotes for a municipality and a service. Electricity keeps the existing utility names. */
export function utilityProfile(code, service) {
  if (serviceOf(service) === 'WATER' && String(code).toUpperCase() === 'JOHANNESBURG') {
    return { utility: 'Johannesburg Water', short: 'Johannesburg', areas: 'system', contact: { phone: '011 688 1400', freephone: null, web: 'johannesburgwater.co.za' } };
  }
  return null;
}
