import { Link } from 'react-router-dom';
import { nice, useApi } from '../lib/api.js';
import { useMyArea } from '../lib/hooks.js';
import { useMunicipality, useUtility } from '../lib/municipality.jsx';
import { AnswerCard, computeAnswer } from './AreaAnswer.jsx';
import Icon from './Icon.jsx';
import SearchBox from './SearchBox.jsx';
import { Skeleton } from './ui.jsx';

/**
 * The home page's answer to "is MY power out?", remembered in this browser.
 * `banner` renders it as one slim full-width strip instead of a tall card.
 */
export default function MyArea({ banner }) {
  const { area, setArea, clear } = useMyArea();
  const { service } = useMunicipality();
  const water = service === 'WATER';
  const { data, loading } = useApi(area ? `/v1/localities/${area.id}/outages?service=${service}` : null, { refreshMs: 60_000 });
  const who = useUtility(data?.municipality?.code);

  if (!area) {
    if (banner) {
      return (
        <div className="area-banner">
          <span className="row" style={{ gap: 10, fontWeight: 500 }}><Icon name="star" /> Save your area</span>
          <span className="muted small area-hint">Pick your suburb once to see if {water ? 'water supply is affected' : 'your power is out'}.</span>
          <div className="area-pick"><SearchBox compact suburbsOnly inline placeholder="Find your suburb…" onPickSuburb={setArea} /></div>
        </div>
      );
    }
    return (
      <div className="card card-pad stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="answer" style={{ padding: 0, border: 0, boxShadow: 'none', background: 'none' }}>
            <div className="ico" style={{ background: 'var(--brand-tint)', color: 'var(--brand)' }}><Icon name="star" /></div>
          </div>
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>Save your area</h2>
            <p className="muted small">Pick your suburb once to see if {water ? 'water supply is affected' : 'your power is out'}.</p>
          </div>
        </div>
        <SearchBox compact suburbsOnly inline placeholder="Find your suburb…" onPickSuburb={setArea} />
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className={banner ? 'card' : 'card card-pad stack'} aria-busy="true" style={banner ? { padding: 16 } : undefined}>
        <Skeleton h={banner ? 22 : 14} w={banner ? '60%' : '30%'} />
        {!banner && <Skeleton h={26} w="80%" />}
        {!banner && <Skeleton h={14} />}
      </div>
    );
  }

  const answer = computeAnswer(nice(area.name), data.data, data.possible, area.id, who, service);
  if (banner) {
    return (
      <AnswerCard
        slim
        answer={answer}
        action={
          <>
            <Link to={`/suburb/${area.id}`} className="btn small">All about {nice(area.name)}</Link>
            <button className="btn ghost small" onClick={clear} title="Pick a different suburb">Change</button>
          </>
        }
      />
    );
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <AnswerCard
        big
        answer={answer}
        action={<Link to={`/suburb/${area.id}`} className="btn small">All about {nice(area.name)}</Link>}
      />
      <div className="row small faint" style={{ justifyContent: 'space-between', padding: '0 4px' }}>
        <span className="row" style={{ gap: 6 }}><Icon name="star" /> Your saved area</span>
        <button className="btn ghost small" onClick={clear}>Change</button>
      </div>
    </div>
  );
}
