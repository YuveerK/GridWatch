import { Link } from 'react-router-dom';
import { nice } from '../lib/api.js';
import { useMyArea } from '../lib/hooks.js';
import { useMunicipality } from '../lib/municipality.jsx';
import { AnswerCard, OtherService, useAreaStatus } from './AreaAnswer.jsx';
import Icon from './Icon.jsx';
import SearchBox from './SearchBox.jsx';
import { Skeleton } from './ui.jsx';

/**
 * The home page's answer to "is anything wrong in MY suburb?", remembered in this browser, as one slim strip.
 * It leads with the service being viewed and always says what the other one is doing, so someone looking at Power
 * still learns that their water is off.
 */
export default function MyArea() {
  const { area, setArea, clear } = useMyArea();
  const { service } = useMunicipality();
  const rows = useAreaStatus(area?.id ?? null, area ? nice(area.name) : '');

  if (!area) {
    return (
      <div className="area-banner">
        <span className="row" style={{ gap: 10, fontWeight: 500 }}><Icon name="star" /> Save your area</span>
        <span className="muted small area-hint">Pick your suburb once to see whether its power or water is affected.</span>
        <div className="area-pick"><SearchBox compact suburbsOnly inline placeholder="Find your suburb…" onPickSuburb={setArea} /></div>
      </div>
    );
  }

  // lead with the service on screen; a suburb outside Water coverage leads with Power whatever is selected
  const primary = rows.find((r) => r.service === service) ?? rows[0];
  const other = rows.find((r) => r !== primary) ?? null;
  if (!primary.answer) {
    return (
      <div className="card" aria-busy="true" style={{ padding: 16 }}>
        <Skeleton h={22} w="60%" />
      </div>
    );
  }

  return (
    <AnswerCard
      slim
      answer={primary.answer}
      service={other ? primary.service : undefined}
      extra={other && <OtherService row={other} localityId={area.id} />}
      action={
        <>
          <Link to={`/suburb/${area.id}`} className="btn small">All about {nice(area.name)}</Link>
          <button className="btn ghost small" onClick={clear} title="Pick a different suburb">Change</button>
        </>
      }
    />
  );
}
