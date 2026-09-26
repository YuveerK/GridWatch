import { useMunicipality } from '../lib/municipality.jsx';

/** The app-wide "which city" scope switcher. A plain select: there will only ever be a handful of municipalities,
 * and unlike a segmented control this doesn't need to reflow as more get added. It lists places only (never a utility),
 * and it disappears when the selected service covers just one city, because there is nothing to choose. */
export default function MunicipalitySwitcher() {
  const { code, setCode, options, service } = useMunicipality();
  const available = (options ?? []).filter((m) => !m.services?.length || m.services.includes(service));
  if (available.length <= 1) return null;
  return (
    <select className="field municipality-switcher" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Area">
      <option value="">All areas covered</option>
      {available.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
    </select>
  );
}
