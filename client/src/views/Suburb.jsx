import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnswerCard, useAreaStatus } from '../components/AreaAnswer.jsx';
import Icon from '../components/Icon.jsx';
import OutageCard from '../components/OutageCard.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { CardSkeleton, Chip, Crumbs, EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui.jsx';
import { fmtDay, nice, plural, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle, useMyArea } from '../lib/hooks.js';
import { useMunicipality, useUtility } from '../lib/municipality.jsx';

const LIVE = new Set(['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED']);

const hoursLabel = (h) => (h == null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h` : `${Math.round(h / 24)} d`);

/** What is usual for this suburb, then every outage as a table row. */
function History({ data, loading, water }) {
  if (loading) return <Skeleton h={200} />;
  if (!data || data.total === 0) return <EmptyState icon="archive" title="No history yet">GridWatch has been watching for {plural(data?.dataDays ?? 0, 'day')} and hasn't seen {water ? 'a water incident' : 'an outage'} here.</EmptyState>;
  const t = data.typical;
  return (
    <>
      <dl className="typical">
        <div>
          <dt>Usually {water ? 'restored' : 'back on'} within</dt>
          <dd className="num">{t.medianHours != null ? hoursLabel(t.medianHours) : '–'}</dd>
          <span>{t.medianHours != null ? `typical, from ${plural(t.restored, 'restored fault')}${t.longExcluded ? `; ${plural(t.longExcluded, 'outage')} over 3 days not counted` : ''}` : `too few restored faults to say (needs ${t.minimum})`}</span>
        </div>
        <div>
          <dt>Usual cause</dt>
          <dd>{t.topCause ? t.topCause.label : '–'}</dd>
          <span>{t.topCause ? `${plural(t.topCause.count, 'outage')} of ${data.faults}` : 'no cause stated yet'}</span>
        </div>
        <div>
          <dt>{water ? 'Supply asset' : 'Equipment'} that keeps appearing</dt>
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
                <td className="num-col num">{o.kind === 'PLANNED' ? 'planned' : o.durationHours != null ? hoursLabel(o.durationHours) : <span className="faint" title={o.retroactive ? `GridWatch only saw the "${water ? 'supply' : 'power'} restored" post, so the start is unknown` : undefined}>{o.retroactive ? 'restored' : o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED' ? 'ongoing' : '–'}</span>}</td>
                <td>{o.equipment.length ? o.equipment.map(nice).join(', ') : <span className="faint">–</span>}</td>
                <td>{o.cause ? nice(o.cause) : <span className="faint">not stated</span>}</td>
                <td className="small muted">{o.alsoAffected.map(nice).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="history-note">Based on {plural(data.dataDays, 'day')} of collected posts. Duration runs from the first post to the post saying {water ? 'water supply' : 'power'} is back, so it can be a little longer than the interruption itself.</p>
    </>
  );
}

const SERVICE_NAME = { ELECTRICITY: 'Power', WATER: 'Water' };

/**
 * Everything about one suburb. "Is anything wrong here?" is answered for every service the suburb's city has (Power,
 * and Water in Johannesburg), whichever service the rest of the site is showing. History and equipment are per service,
 * with their own switch so reading the water history doesn't change the site-wide choice.
 */
export default function Suburb() {
  const { id } = useParams();
  const { service } = useMunicipality();
  const suburb = useApi(`/v1/localities/${id}`);
  const code = suburb.data?.municipalityCode ?? null;
  const rows = useAreaStatus(suburb.data ? id : null, suburb.data ? nice(suburb.data.name) : '', code);
  const services = rows.map((r) => r.service);
  const [picked, setPicked] = useState(null);
  const histService = picked && services.includes(picked) ? picked : services.includes(service) ? service : 'ELECTRICITY';
  const water = histService === 'WATER';
  const hist = useApi(suburb.data ? `/v1/localities/${id}/history?service=${histService}` : null);
  const { area, setArea, clear } = useMyArea();
  useDocumentTitle(suburb.data?.name);
  const who = useUtility(code, histService);

  if (suburb.error) return <div className="container page"><ErrorState error={suburb.error} /></div>;
  if (!suburb.data || rows.some((r) => !r.answer)) {
    return (
      <div className="container page stack" aria-busy="true">
        <Skeleton h={16} w="25%" /><Skeleton h={34} w="45%" /><Skeleton h={130} r={16} /><CardSkeleton n={2} />
      </div>
    );
  }

  const s = { ...suburb.data, name: nice(suburb.data.name) };
  const both = rows.length > 1;
  const current = rows.flatMap((r) => r.data.data).filter((o) => LIVE.has(o.status));
  const possible = rows.flatMap((r) => r.data.possible ?? []);
  const saved = area?.id === s.id;
  const infrastructure = s.infrastructure.filter((n) => n.serviceType === histService);

  return (
    <div className="container page">
      <Crumbs items={[{ label: 'Home', to: '/' }, { label: s.name }]} />

      <header className="page-head" style={{ marginBottom: 18 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1>{s.name}</h1>
            <p style={{ marginTop: 4, fontSize: 15 }}>
              {s.region ? `Region ${s.region}${s.municipality ? ` of ${s.municipality}` : ''}` : s.municipality ?? 'Suburb'}
              {s.learned && ' · added automatically from outage posts'}
              {s.electricitySupplier && ` · electricity from ${s.electricitySupplier}`}
            </p>
          </div>
          <button className={`btn ${saved ? '' : 'primary'}`} onClick={() => (saved ? clear() : setArea({ id: s.id, name: s.name }))} aria-pressed={saved}>
            <Icon name="star" /> {saved ? 'Saved as your area' : 'Save as my area'}
          </button>
        </div>
      </header>

      <div className={both ? 'answer-pair' : undefined}>
        {rows.map((r) => <AnswerCard key={r.service} big answer={r.answer} service={both ? r.service : undefined} />)}
      </div>

      {current.length > 0 && (
        <section className="section" aria-labelledby="cur-h">
          <SectionHead id="cur-h" title="Current" sub={`${both ? 'Power and water incidents' : 'Electricity outages'} and planned work affecting this suburb`} />
          <div className="grid-cards">{current.map((o) => <OutageCard key={o.id} outage={o} showService={both} />)}</div>
        </section>
      )}

      {possible.length > 0 && (
        <section className="section" aria-labelledby="pos-h">
          <SectionHead id="pos-h" title="Possibly affecting this area" sub={`The utility didn't name a suburb, but the equipment involved usually supplies ${s.name}`} />
          <div className="grid-cards">{possible.map((o) => <OutageCard key={o.id} outage={o} showService={both} />)}</div>
        </section>
      )}

      <section className="section" aria-labelledby="his-h">
        <SectionHead
          id="his-h"
          title={`${water ? 'Water incident' : 'Electricity outage'} history for ${s.name}`}
          sub="Reported incidents that have affected this suburb, and what is usual here"
          action={both && (
            <div className="seg" role="group" aria-label="History for">
              {services.map((sv) => <button key={sv} type="button" aria-pressed={sv === histService} onClick={() => setPicked(sv)}><Icon name={sv === 'WATER' ? 'drop' : 'bolt'} />{SERVICE_NAME[sv]}</button>)}
            </div>
          )}
        />
        <History data={hist.data} loading={hist.loading && !hist.data} water={water} />
      </section>

      {infrastructure.length > 0 && (
        <section className="section" aria-labelledby="eq-h">
          <SectionHead id="eq-h" title={`${water ? 'Water assets' : 'Equipment'} that supplies this area`} sub={`Learned from ${who.utility}'s past posts, so it may be incomplete`} />
          <div className="card card-pad">
            <div className="chips">
              {infrastructure.map((n) => (
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
