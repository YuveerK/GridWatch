import { Link, useParams } from 'react-router-dom';
import { AnswerCard, computeAnswer } from '../components/AreaAnswer.jsx';
import Icon from '../components/Icon.jsx';
import OutageCard from '../components/OutageCard.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { CardSkeleton, Chip, Crumbs, EmptyState, ErrorState, SectionHead, Skeleton, StatusBadge } from '../components/ui.jsx';
import { fmtDay, nice, plural, prettySdc, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle, useMyArea } from '../lib/hooks.js';

const LIVE = new Set(['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED']);

const hoursLabel = (h) => (h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h` : `${Math.round(h / 24)} d`);

/** What is usual for this suburb, then every outage as a table row. */
function History({ data, loading }) {
  if (loading) return <Skeleton h={200} />;
  if (!data || data.total === 0) return <EmptyState icon="archive" title="No history yet">GridWatch has been watching for {plural(data?.dataDays ?? 0, 'day')} and hasn't seen an outage here.</EmptyState>;
  const t = data.typical;
  return (
    <>
      <dl className="typical">
        <div>
          <dt>Usually back on within</dt>
          <dd className="num">{t.medianHours != null ? hoursLabel(t.medianHours) : '–'}</dd>
          <span>{t.medianHours != null ? `typical, from ${plural(t.restored, 'restored fault')}` : `too few restored faults to say (needs ${t.minimum})`}</span>
        </div>
        <div>
          <dt>Usual cause</dt>
          <dd>{t.topCause ? t.topCause.label : '–'}</dd>
          <span>{t.topCause ? `${plural(t.topCause.count, 'outage')} of ${data.faults}` : 'no cause stated yet'}</span>
        </div>
        <div>
          <dt>Equipment that keeps appearing</dt>
          <dd>{t.topEquipment ? nice(t.topEquipment.name) : '–'}</dd>
          <span>{t.topEquipment ? `in ${plural(t.topEquipment.count, 'outage')}` : 'nothing repeats yet'}</span>
        </div>
      </dl>
      <div className="matrix-wrap">
        <table className="matrix history-table">
          <thead>
            <tr><th scope="col">Date</th><th scope="col" className="num-col">Lasted</th><th scope="col">Equipment</th><th scope="col">Cause</th><th scope="col">Also affected</th></tr>
          </thead>
          <tbody>
            {data.rows.map((o) => (
              <tr key={o.id}>
                <th scope="row"><Link to={`/outages/${o.id}`}>{fmtDay(o.startedAt)}</Link></th>
                <td className="num-col num">{o.kind === 'PLANNED' ? 'planned' : o.durationHours != null ? hoursLabel(o.durationHours) : <span className="faint" title={o.retroactive ? 'GridWatch only saw the "power restored" post, so the start is unknown' : undefined}>{o.retroactive ? 'restored' : o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED' ? 'ongoing' : '–'}</span>}</td>
                <td>{o.equipment.length ? o.equipment.map(nice).join(', ') : <span className="faint">–</span>}</td>
                <td>{o.cause ? nice(o.cause) : <span className="faint">not stated</span>}</td>
                <td className="small muted">{o.alsoAffected.map(nice).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="history-note">Based on {plural(data.dataDays, 'day')} of collected posts. How long an outage "lasted" runs from the first post to the post saying power is back, so it can be a little longer than the fault itself.</p>
    </>
  );
}

export default function Suburb() {
  const { id } = useParams();
  const suburb = useApi(`/v1/localities/${id}`);
  const outages = useApi(`/v1/localities/${id}/outages`, { refreshMs: 60_000 });
  const hist = useApi(`/v1/localities/${id}/history`);
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
        <SectionHead id="his-h" title={`Outage history for ${s.name}`} sub="Every outage that has affected this suburb, and what is usual here" />
        <History data={hist.data} loading={hist.loading && !hist.data} />
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
