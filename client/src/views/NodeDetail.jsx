import { Link, useParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import FeedFlow from '../components/FeedFlow.jsx';
import NodeReach from '../components/NodeReach.jsx';
import OutageCard from '../components/OutageCard.jsx';
import { Chip, Crumbs, ErrorState, SectionHead, ServiceIdentity, Skeleton } from '../components/ui.jsx';
import { fmtDay, nice, plural, prettySdc, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useUtility } from '../lib/municipality.jsx';

const ABOUT = {
  SDC: 'A service centre is a regional depot that looks after part of the city and sends out repair teams.',
  SUBSTATION: 'A large site that receives high-voltage power and sends it out to several distributors.',
  SWITCHING_STATION: 'A site that routes power between circuits. When it trips, everything it feeds can go dark.',
  DISTRIBUTOR: 'A circuit that leaves a substation and feeds a group of streets.',
  MINI_SUBSTATION: 'A small street-level unit that steps power down for a few blocks.',
  FEEDER: 'A cable that carries power from one station to the next.',
  TRANSFORMER: 'Steps voltage down before it reaches homes.',
  RESERVOIR: 'Stores water for the surrounding supply network.',
  WATER_TOWER: 'Elevated storage that helps maintain water pressure.',
  PUMP_STATION: 'Moves water through the supply network.',
  BOOSTER_STATION: 'Helps maintain pressure farther along the supply route.',
  TREATMENT_WORKS: 'Treats water before it enters the distribution system.',
  DIRECT_FEED: 'A direct water supply route serving an area.',
  WATER_SYSTEM: 'A named part of the water supply network.',
  WATER_PIPELINE: 'A pipeline carrying water between parts of the network.',
};

export default function NodeDetail() {
  const { id } = useParams();
  const { data: n, error, loading } = useApi(`/v1/infrastructure/${id}`);
  useDocumentTitle(n?.name);
  const { utility } = useUtility(n?.municipalityId, n?.serviceType);

  if (error && !n) return <div className="container page"><ErrorState error={error} /></div>;
  if (loading || !n) return <div className="container page stack" aria-busy="true"><Skeleton h={16} w="30%" /><Skeleton h={40} w="50%" /><Skeleton h={200} /></div>;

  const live = n.recentOutages.filter((o) => o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED');
  const water = n.serviceType === 'WATER';
  const past = n.recentOutages.filter((o) => !live.includes(o));
  const grouped = n.children.reduce((acc, c) => {
    (acc[c.child.type] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="container page">
      <Crumbs items={[{ label: 'Network', to: '/network' }, ...n.chain.map((c) => ({ label: c.type === 'SDC' ? prettySdc(c.name) : c.name, to: `/network/${c.id}` })), { label: n.type === 'SDC' ? prettySdc(n.name) : n.name }]} />

      <header className="page-head">
        <div className="row" style={{ gap: 10, marginBottom: 8 }}>
          <ServiceIdentity service={n.serviceType} />
          <span className="eyebrow">{typeLabel(n.type)}</span>
          {live.length > 0 ? <span className="badge tone-live"><Icon name="alert" />{plural(live.length, 'live outage')}</span> : <span className="badge tone-good"><Icon name="check" />No live outage</span>}
        </div>
        <h1>{n.type === 'SDC' ? prettySdc(n.name) : nice(n.name)}</h1>
        <p>{ABOUT[n.type] ?? `An asset mentioned in ${utility}'s posts.`}</p>
      </header>

      <div className="cols-3" style={{ marginBottom: 8 }}>
        <div className="card card-pad"><div className="small muted">Mentioned in</div><div style={{ fontSize: 28, fontWeight: 600 }} className="num">{plural(n.evidenceCount, 'post')}</div><div className="small faint">{n.lifecycle === 'CONFIRMED' ? 'Confirmed by several posts' : 'Seen only once so far'}</div></div>
        <div className="card card-pad"><div className="small muted">First seen</div><div style={{ fontSize: 22, fontWeight: 600 }}>{fmtDay(n.firstSeenAt)}</div></div>
        <div className="card card-pad"><div className="small muted">Last seen</div><div style={{ fontSize: 22, fontWeight: 600 }}>{fmtDay(n.lastSeenAt)}</div></div>
      </div>

      <section className="section" aria-labelledby="flow-h">
        <SectionHead id="flow-h" title={water ? 'Known supply connections' : 'How power flows here'} sub={`Connections inferred from ${utility}'s posts; this may not show the complete route`} />
        <FeedFlow node={n} />
      </section>

      {live.length > 0 && (
        <section className="section">
          <SectionHead title="Live outages" />
          <div className="grid-cards">{live.map((o) => <OutageCard key={o.id} outage={o} />)}</div>
        </section>
      )}

      {n.children.length > 0 && (
        <section className="section">
          <SectionHead title={n.type === 'SDC' ? 'Equipment it looks after' : 'What it feeds'} sub={`Equipment seen downstream of this one in ${utility}'s posts`} />
          <div className="stack" style={{ gap: 14 }}>
            {Object.entries(grouped).map(([type, list]) => (
              <div key={type} className="card card-pad">
                <div className="small muted" style={{ marginBottom: 10, fontWeight: 500 }}>{typeLabel(type)}s · {list.length}</div>
                <div className="chips">
                  {list.map((c) => (
                    <Link key={c.childId} to={`/network/${c.childId}`} className="chip">
                      {c.child.live && <span className="dot live" style={{ width: 7, height: 7 }} title="Outage in progress" />}
                      {nice(c.child.name)}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <NodeReach id={n.id} service={n.serviceType} />

      {n.localities.length > 0 && (
        <section className="section">
          <SectionHead title="Areas affected when it fails" sub={`Suburbs named in ${water ? 'water incidents' : 'electricity outages'} involving this asset. More reports make this more complete.`} />
          <div className="card card-pad"><div className="chips">{n.localities.map((l) => <Chip key={l.localityId} to={`/suburb/${l.localityId}`} title={`Seen in ${plural(l.evidenceCount, 'post')}`}>{nice(l.locality.canonicalName)} <small>{l.evidenceCount}×</small></Chip>)}</div></div>
        </section>
      )}

      {past.length > 0 && (
        <section className="section">
          <SectionHead title="Recent history" />
          <div className="grid-cards">{past.map((o) => <OutageCard key={o.id} outage={o} compact />)}</div>
        </section>
      )}

      {n.aliases.length > 0 && <p className="small faint" style={{ marginTop: 26 }}>Also written as: {n.aliases.map((a) => a.alias).join(', ')}</p>}
    </div>
  );
}
