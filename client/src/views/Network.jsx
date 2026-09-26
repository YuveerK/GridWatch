import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import SuburbSupply from '../components/SuburbSupply.jsx';
import { CardSkeleton, EmptyState, ErrorState, SectionHead, ServiceIdentity, Skeleton } from '../components/ui.jsx';
import { nice, plural, prettySdc, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, withMunicipality } from '../lib/municipality.jsx';

const POWER_TYPES = ['', 'SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'TRANSFORMER', 'CABLE'];
const WATER_TYPES = ['', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'BOOSTER_STATION', 'TREATMENT_WORKS', 'WATER_SYSTEM', 'DIRECT_FEED', 'BULK_CONNECTION', 'WATER_PIPELINE'];
const PATHS = {
  ELECTRICITY: [
    ['plug', 'Service centre', 'A regional depot dispatches repair teams; it is not a point in the electrical supply path.'],
    ['bolt', 'Substation', 'A site that steps voltage down and sends electricity onto local circuits.'],
    ['network', 'Distributor or feeder', 'A circuit carries power towards a group of streets.'],
    ['home', 'Your area', 'A fault upstream can affect several suburbs at once.'],
  ],
  WATER: [
    ['drop', 'Water source', 'Bulk supply or treatment works introduces water to the network.'],
    ['network', 'Storage and pumping', 'Reservoirs, towers and pump stations help manage supply and pressure.'],
    ['arrow', 'Supply route', 'Pipelines and direct feeds carry water towards neighbourhoods.'],
    ['home', 'Your area', 'An upstream interruption can affect more than one suburb.'],
  ],
};

export function Explainer({ service = 'ELECTRICITY' }) {
  return <div className="card card-pad network-explainer">
    <div className="flow">{PATHS[service].map(([icon, title, description], index) =>
      <div key={title} className="step"><span className="network-step-icon"><Icon name={icon} /></span><span className="n">STEP {index + 1}</span><b>{title}</b><span className="small muted">{description}</span></div>
    )}</div>
    <p className="small muted network-caveat">This is a guide to how the service works. The assets and connections below are inferred from public posts, so they are incomplete and are not an official network diagram.</p>
  </div>;
}

export default function Network() {
  useDocumentTitle('Network');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const { param, name, service } = useMunicipality();
  const water = service === 'WATER';
  const types = water ? WATER_TYPES : POWER_TYPES;
  const selectedType = types.includes(type) ? type : '';
  const sdcs = useApi(water ? null : withMunicipality('/v1/network/sdcs', param));
  const query = new URLSearchParams();
  if (selectedType) query.set('type', selectedType);
  if (q.trim().length > 1) query.set('q', q.trim());
  const list = useApi(withMunicipality(`/v1/infrastructure?${query}`, param));
  const nodes = list.data?.data ?? [];
  const shownSdcs = sdcs.data?.data.filter((s) => s.equipment > 0 || s.live + s.partial + s.planned > 0) ?? [];

  return <div className="container page network-page">
    <header className="page-head network-head">
      <ServiceIdentity service={service} />
      <h1>{water ? 'Water supply network' : 'Electricity network'}</h1>
      <p>{water
        ? `See what supplies a suburb, then browse the reservoirs, towers and direct feeds mentioned in water notices${name ? ` for ${name}` : ''}.`
        : `See what supplies a suburb, then browse the service centres and equipment mentioned in electricity notices${name ? ` for ${name}` : ''}.`}</p>
    </header>
    <SuburbSupply />
    <Explainer service={service} />

    {!water && <section className="section" aria-labelledby="sdc-h">
      <SectionHead id="sdc-h" title="Service centres" sub="Regional depots that coordinate electricity repairs" />
      {sdcs.error && !sdcs.data && <ErrorState error={sdcs.error} />}
      {!sdcs.data && !sdcs.error && <CardSkeleton n={3} />}
      {sdcs.data && shownSdcs.length === 0 && <EmptyState icon="network" title="No service centres reported">Try a different municipality or explore the equipment below.</EmptyState>}
      {shownSdcs.length > 0 && <div className="grid-cards">{shownSdcs.map((s) =>
        <Link key={s.id} to={`/network/${s.id}`} className="card sdc-card">
          <div className="row between"><h3>{prettySdc(s.name)}</h3>{s.live + s.partial > 0 ? <span className="badge tone-live"><Icon name="alert" />{s.live + s.partial} live</span> : <span className="badge tone-good"><Icon name="check" />No live outage</span>}</div>
          <div className="mini"><span><b className="num">{s.equipment}</b> linked assets</span><span><b className="num">{s.planned}</b> planned</span></div>
        </Link>
      )}</div>}
    </section>}

    <section className="section" aria-labelledby="eq-h">
      <SectionHead id="eq-h" title={water ? 'Explore water assets' : 'Explore electricity equipment'} sub={water ? 'Filter by asset type or search for a named supply system' : 'Filter by equipment type or search by name'} />
      <div className="toolbar network-toolbar">
        <div className="seg" role="group" aria-label="Asset type">{types.map((t) => <button key={t || 'all'} type="button" aria-pressed={selectedType === t} onClick={() => setType(t)}>{t ? typeLabel(t) : 'All assets'}</button>)}</div>
        <input className="field" type="search" placeholder={water ? 'Search water assets' : 'Search equipment'} aria-label="Search assets by name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.error && !list.data && <ErrorState error={list.error} />}
      {!list.data && !list.error && <Skeleton h={200} />}
      {list.data && <>
        <p className="small muted network-count">{plural(nodes.length, 'asset')} shown{nodes.length === 100 ? ' (first 100 matches)' : ''}</p>
        {nodes.length === 0 ? <EmptyState icon={water ? 'drop' : 'bolt'} title="No matching assets">Try another type or search term. The network fills in as more public notices are collected.</EmptyState> :
          <div className="network-assets">{nodes.map((n) =>
            <Link key={n.id} to={`/network/${n.id}`} className={`card network-asset ${water ? 'service-water' : 'service-power'}`}>
              <span className="network-asset-icon"><Icon name={water ? 'drop' : 'bolt'} /></span>
              <span className="network-asset-main"><strong>{nice(n.name)}</strong><span>{typeLabel(n.type)} · {plural(n.evidenceCount, 'post')}{n.lifecycle === 'CONFIRMED' ? '' : ' · reported once'}</span></span>
              {n.live && <span className="badge tone-live"><Icon name="alert" />Live incident</span>}
              <Icon name="chevron" />
            </Link>
          )}</div>}
      </>}
    </section>
  </div>;
}
