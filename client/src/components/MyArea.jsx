import { Link } from 'react-router-dom';
import { nice, useApi } from '../lib/api.js';
import { useMyArea } from '../lib/hooks.js';
import { AnswerCard, computeAnswer } from './AreaAnswer.jsx';
import Icon from './Icon.jsx';
import SearchBox from './SearchBox.jsx';
import { Skeleton } from './ui.jsx';

/** The home page's answer to "is MY power out?" — remembers the suburb in this browser. */
export default function MyArea() {
  const { area, setArea, clear } = useMyArea();
  const { data, loading } = useApi(area ? `/v1/localities/${area.id}/outages` : null, { refreshMs: 60_000 });

  if (!area) {
    return (
      <div className="card card-pad stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="answer" style={{ padding: 0, border: 0, boxShadow: 'none', background: 'none' }}>
            <div className="ico" style={{ background: 'var(--brand-tint)', color: 'var(--brand)' }}><Icon name="star" /></div>
          </div>
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 750, letterSpacing: '-0.015em' }}>Save your area</h2>
            <p className="muted small">Pick your suburb once and this page will tell you straight away if your power is out.</p>
          </div>
        </div>
        <SearchBox compact suburbsOnly inline placeholder="Find your suburb…" onPickSuburb={setArea} />
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="card card-pad stack" aria-busy="true">
        <Skeleton h={14} w="30%" />
        <Skeleton h={26} w="80%" />
        <Skeleton h={14} />
      </div>
    );
  }

  const answer = computeAnswer(nice(area.name), data.data, data.possible);
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
