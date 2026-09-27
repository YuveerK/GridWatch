import { withService } from './query.js';

/** This computer on the home network. A phone cannot reach localhost. */
const LAN_HOST = '192.168.0.106';
const configured = (process.env.EXPO_PUBLIC_API_URL || `http://${LAN_HOST}:4000`).replace(/\/$/, '');

export const API_URL = configured.replace(/\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)\b/, `//${LAN_HOST}`);

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type ServiceName = 'ELECTRICITY' | 'WATER';

export type LocalityRef = {
  id: string;
  canonicalName: string;
  restored?: boolean;
};

export type Outage = {
  id: string;
  title: string;
  status: string;
  service: ServiceName;
  waterState: string | null;
  cause: string | null;
  eta: string | null;
  restorationPercent: number | null;
  lastUpdateAt: string | null;
  startedAt: string | null;
  localities?: LocalityRef[];
  infrastructure?: { id: string; name: string; type: string }[];
  latest?: { summary: string | null; at: string } | null;
  municipality?: { name: string } | null;
  sdc?: string | null;
  postCount?: number | null;
  scheduled?: { date: string; from: string | null; to: string | null } | null;
  timeline?: TimelineItem[];
};

export type TimelineItem = {
  role: string;
  summary: string | null;
  postedAt: string;
  text: string | null;
  url: string | null;
};

export type MapPlace = {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  restored?: boolean;
  inferred?: boolean;
  boundary?: GeoJSON.Geometry | null;
};

export type MapOutage = {
  id: string;
  title: string;
  status: string;
  service: ServiceName;
  waterState: string | null;
  lastUpdateAt: string | null;
  places: MapPlace[];
};

export type SearchSuburb = {
  id: string;
  name: string;
  municipality: string | null;
  lat: number | null;
  lon: number | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'offline');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (body as { error?: string })?.error ?? 'request_failed');
  return body as T;
}

export const api = {
  sync: () => request<{ lastSyncAt: string | null; latestStatus: string | null }>('/v1/sync'),

  outages: (service: ServiceName, options?: { status?: string; q?: string; sdc?: string; sort?: 'updated' | 'started' | 'name'; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 30));
    params.set('offset', String(options?.offset ?? 0));
    params.set('sort', options?.sort ?? 'updated');
    if (options?.status) params.set('status', options.status);
    if (options?.q) params.set('q', options.q);
    if (options?.sdc) params.set('sdc', options.sdc);
    return request<{ data: Outage[]; total: number }>(withService(`/v1/outages?${params}`, service));
  },

  stats: (service: ServiceName) =>
    request<{ outagesByStatus: Record<string, number>; activeBySdc: { sdc: string; count: number }[] }>(withService('/v1/stats', service)),

  outage: (id: string) => request<Outage>(`/v1/outages/${encodeURIComponent(id)}`),

  search: (q: string, service: ServiceName) =>
    request<{ suburbs: SearchSuburb[]; outages: { id: string; title: string; status: string; service: ServiceName; waterState: string | null }[] }>(
      withService(`/v1/search?q=${encodeURIComponent(q)}`, service),
    ),

  locality: (id: string) =>
    request<{ id: string; name: string; municipality: string | null }>(`/v1/localities/${encodeURIComponent(id)}`),

  localityOutages: (id: string, service: ServiceName) =>
    request<{ data: Outage[]; possible: Outage[] }>(withService(`/v1/localities/${encodeURIComponent(id)}/outages`, service)),

  map: (service: ServiceName) => request<{ data: MapOutage[] }>(withService('/v1/map', service)),

  registerDevice: (body: { token: string; platform: 'ios' | 'android'; quietFrom: number | null; quietTo: number | null }) =>
    request<{ data: { id: string } }>('/v1/push/devices', { method: 'POST', body: JSON.stringify(body) }),

  replaceSubscriptions: (token: string, localityIds: string[]) =>
    request<{ data: { following: number } }>('/v1/push/subscriptions', {
      method: 'PUT',
      body: JSON.stringify({ token, localityIds }),
    }),
};
