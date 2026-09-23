import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { CardSkeleton, EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui.jsx';
import { nice, plural, prettySdc, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, withMunicipality } from '../lib/municipality.jsx';

const TYPES = ['', 'SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'TRANSFORMER', 'LINE'];

export function Explainer() {
  const steps = [
    ['1', 'Service centre', 'A regional depot that dispatches repair teams. Also called an SDC - not every city organizes its network this way.'],
    ['2', 'Substation', 'A large site that steps electricity down and sends it out on several lines.'],
    ['3', 'Distributor', 'A cable or circuit leaving the substation that feeds a group of streets.'],
    ['4', 'Your suburb', 'The homes and businesses on that circuit lose power together when it faults.'],
  ];
  return (
    <div className="card card-pad">
      <div className="flow">
        {steps.map(([n, t, d]) => (
          <div key={n} className="step">
            <span className="n">STEP {n}</span>
            <b>{t}</b>
            <span className="small muted">{d}</span>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>
        GridWatch builds this map itself by reading each city's own outage posts, so it grows more complete over time. It shows what has been reported, not any utility's official network diagram.
      </p>
    </div>
  );
}

export default function Network() {
  useDocumentTitle('Network');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const { param: muniParam, name } = useMunicipality();
  const sdcs = useApi(withMunicipality('/v1/network/sdcs', muniParam));
  const list = useApi(withMunicipality(`/v1/infrastructure?${type ? `type=${type}&` : ''}${q.trim().length > 1 ? `q=${encodeURIComponent(q.trim())}` : ''}`, muniParam));
  const shownSdcs = sdcs.data?.data.filter((s) => s.equipment > 0 || s.live + s.partial + s.planned > 0) ?? [];

  return (
    <div className="container page">
      <header className="page-head">
        <h1>Power network</h1>
        <p>How electricity reaches your suburb{name ? ` in ${name}` : ''}, as far as posts have shown us. Pick a service centre to explore its equipment.</p>
      </header>
      <Explainer />

      <section className="section" aria-labelledby="sdc-h">
        <SectionHead id="sdc-h" title="Service centres" sub="Tap one to see what it looks after" />
        {sdcs.error && !sdcs.data && <ErrorState error={sdcs.error} />}
        {!sdcs.data && !sdcs.error && <CardSkeleton n={6} />}
        {sdcs.data && shownSdcs.length === 0 && (
          <EmptyState icon="network" title="No service centres here">
            {name ? `${name} doesn't organize its network into service centres, at least not in what it's posted so far.` : "Nothing's been reported yet."}
          </EmptyState>
        )}
        {sdcs.data && shownSdcs.length > 0 && (
          <div className="grid-cards">
            {shownSdcs.map((s) => (
              <Link key={s.id} to={`/network/${s.id}`} className="card sdc-card">
                <div className="row between">
                  <h3>{prettySdc(s.name)}</h3>
                  {s.live + s.partial > 0 ? <span className="badge tone-live"><Icon name="alert" />{s.live + s.partial} live</span> : <span className="badge tone-good"><Icon name="check" />All clear</span>}
                </div>
                <div className="mini">
                  <span><b className="num">{s.equipment}</b> pieces of equipment</span>
                  <span><b className="num">{s.planned}</b> planned</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="eq-h">
        <SectionHead id="eq-h" title="Find equipment" sub="Search every substation, distributor and feeder we know about" />
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Equipment type">
            {TYPES.map((t) => <button key={t || 'all'} aria-pressed={type === t} onClick={() => setType(t)}>{t ? typeLabel(t) : 'All'}</button>)}
          </div>
          <input className="field" type="search" placeholder="Search by name" aria-label="Search equipment by name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {list.error && !list.data && <ErrorState error={list.error} />}
        {!list.data && !list.error && <Skeleton h={200} />}
        {list.data && (
          <div className="card">
            <ul className="rows">
              {list.data.data.map((n) => (
                <li key={n.id}>
                  <div className="grow">
                    <Link to={`/network/${n.id}`} className="t">{nice(n.name)}</Link>
                    <div className="small muted">{typeLabel(n.type)} · seen in {plural(n.evidenceCount, 'post')}{n.lifecycle === 'CONFIRMED' ? '' : ' · not yet confirmed'}</div>
                  </div>
                  {n.live && <span className="badge tone-live"><Icon name="alert" />Outage</span>}
                  <Icon name="chevron" />
                </li>
              ))}
              {list.data.data.length === 0 && <li className="muted">Nothing matches.</li>}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

