import { useMunicipality } from '../lib/municipality.jsx';

/** The app-wide "which city" scope switcher. A plain select: there will only ever be a handful of municipalities,
 * and unlike a segmented control this doesn't need to reflow as more get added. */
export default function MunicipalitySwitcher() {
  const { code, setCode, options } = useMunicipality();
  if (!options.length) return null;
  return (
    <select className="field municipality-switcher" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Municipality">
      <option value="">All of Gauteng</option>
      {options.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
    </select>
  );
}
