import { Link, useParams } from 'react-router-dom';
import { AnswerCard, computeAnswer } from '../components/AreaAnswer.jsx';
import Icon from '../components/Icon.jsx';
import OutageCard from '../components/OutageCard.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { CardSkeleton, Chip, Crumbs, EmptyState, ErrorState, SectionHead, Skeleton, StatusBadge } from '../components/ui.jsx';
import { fmtDay, nice, prettySdc, timeAgo, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle, useMyArea } from '../lib/hooks.js';

const LIVE = new Set(['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED']);

export default function Suburb() {
  const { id } = useParams();
  const suburb = useApi(`/v1/localities/${id}`);
  const outages = useApi(`/v1/localities/${id}/outages`, { refreshMs: 60_000 });
  const { area, setArea, clear } = useMyArea();
  useDocumentTitle(suburb.data?.name);

  if (suburb.error) return <div className="container page"><ErrorState error={suburb.error} /></div>;
  if (!suburb.data || !outages.data) {
    return (
      <div className="container page stack" aria-busy="true">
        <Skeleton h={16} w="25%" /><Skeleton h={34} w="45%" /><Skeleton h={130} r={16} /><CardSkeleton n={2} />
      </div>
    );
  }

  const s = { ...suburb.data, name: nice(suburb.data.name) };
  const list = outages.data.data;
  const possible = outages.data.possible ?? [];
  const current = list.filter((o) => LIVE.has(o.status));
  const history = list.filter((o) => !LIVE.has(o.status));
  const saved = area?.id === s.id;
  const answer = computeAnswer(s.name, list, possible, s.id);

  return (
    <div className="container page">
      <Crumbs items={[{ label: 'Home', to: '/' }, { label: 'Suburbs' }, { label: s.name }]} />

      <header className="page-head" style={{ marginBottom: 18 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1>{s.name}</h1>
            <p style={{ marginTop: 4, fontSize: 15 }}>
              {s.region ? `Region ${s.region} of Johannesburg` : 'Johannesburg'}
              {s.learned && ' · added automatically from City Power posts'}
            </p>
          </div>
          <button className={`btn ${saved ? '' : 'primary'}`} onClick={() => (saved ? clear() : setArea({ id: s.id, name: s.name }))} aria-pressed={saved}>
            <Icon name="star" /> {saved ? 'Saved as your area' : 'Save as my area'}
          </button>
        </div>
      </header>

      <AnswerCard big answer={answer} />

      {current.length > 0 && (
        <section className="section" aria-labelledby="cur-h">
          <SectionHead id="cur-h" title="Current" sub="Outages and planned work affecting this suburb" />
          <div className="grid-cards">{current.map((o) => <OutageCard key={o.id} outage={o} />)}</div>
        </section>
      )}

      {possible.length > 0 && (
        <section className="section" aria-labelledby="pos-h">
          <SectionHead id="pos-h" title="Possibly affecting this area" sub={`City Power didn't name a suburb, but this equipment usually supplies ${s.name}`} />
          <div className="grid-cards">{possible.map((o) => <OutageCard key={o.id} outage={o} />)}</div>
        </section>
      )}

      <section className="section" aria-labelledby="his-h">
        <SectionHead id="his-h" title="Recent history" sub="Finished outages in this suburb" />
        {history.length ? (
          <div className="card">
            <ul className="rows">
              {history.map((o) => (
                <li key={o.id}>
                  <div className="grow">
                    <Link to={`/outages/${o.id}`} className="t">{nice(o.title)}</Link>
                    <div className="small muted">{fmtDay(o.startedAt)}{o.cause ? ` · ${o.cause}` : ''}{o.sdc ? ` · ${prettySdc(o.sdc)}` : ''}</div>
                  </div>
                  <StatusBadge status={o.status} kind={o.kind} />
                  <span className="small faint" style={{ minWidth: 76, textAlign: 'right' }}>{timeAgo(o.lastUpdateAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState icon="archive" title="No history yet">GridWatch has been watching for about ten days and hasn't seen an outage here.</EmptyState>
        )}
      </section>

      {s.infrastructure.length > 0 && (
        <section className="section" aria-labelledby="eq-h">
          <SectionHead id="eq-h" title="Equipment that supplies this area" sub="Learned from past outage posts, so it may be incomplete" />
          <div className="card card-pad">
            <div className="chips">
              {s.infrastructure.map((n) => (
                <Chip key={n.id} to={`/network/${n.id}`}>
                  {nice(n.name)} <small>{typeLabel(n.type)}</small>
                </Chip>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <SectionHead title="Check another suburb" />
        <div style={{ maxWidth: 520 }}><SearchBox suburbsOnly placeholder="Search a suburb" /></div>
      </section>
    </div>
  );
}
