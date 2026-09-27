import { useState } from 'react';
import { Link } from 'react-router-dom';
import { nice, prettySdc, typeLabel } from '../lib/api.js';
import { inService } from '../lib/service.jsx';
import { assetSymbol, bandFor, diagramCopy, groupByBand, isAdministrativeEdge, linkLabel } from '../lib/network.js';
import Icon from './Icon.jsx';
import NetworkEvidence from './NetworkEvidence.jsx';

function ExpandList({ items, render, initial = 10, step = 20 }) {
  const [limit, setLimit] = useState(initial);
  return <>
    <ul className="connection-items">{items.slice(0, limit).map(render)}</ul>
    {items.length > limit && <button className="btn small" onClick={() => setLimit(limit + step)}>Show {Math.min(step, items.length - limit)} more ({items.length} total)</button>}
    {limit > initial && <button className="btn small ghost" onClick={() => setLimit(initial)}>Show fewer</button>}
  </>;
}

function Stem({ fan = false, up = false }) {
  return <div className={`diagram-stem${fan ? ' is-fan' : ''}${up ? ' up' : ''}`} aria-hidden="true" />;
}

function TierHead({ step, title, count }) {
  return <header className="diagram-tier-h"><span className="diagram-step">{step}</span><h3>{title} ({count})</h3></header>;
}

function Bands({ items, service, render }) {
  const groups = groupByBand(items, service, (edge) => edge.asset.type);
  return groups.map((group) => <div key={group.id} className="diagram-band">
    {groups.length > 1 && <h4>{group.label}</h4>}
    <ExpandList items={group.items} render={render} />
  </div>);
}

function assetName(asset) {
  return asset.type === 'SDC' ? prettySdc(asset.name) : nice(asset.name);
}

/** Top-to-bottom supply hierarchy: what feeds this asset, then the suburbs it reaches. */
export default function FeedFlow({ node, onSelect, onSuburb }) {
  const [evidence, setEvidence] = useState(null);
  const copy = diagramCopy(node.serviceType, node.type);
  const parents = (node.parents ?? []).map((edge) => ({ ...edge, asset: edge.parent, direction: 'in' }));
  const children = (node.children ?? []).map((edge) => ({ ...edge, asset: edge.child, direction: 'out' }));
  const incoming = parents.filter((edge) => !isAdministrativeEdge(edge));
  const outgoing = children.filter((edge) => !isAdministrativeEdge(edge));
  const related = [...parents, ...children].filter(isAdministrativeEdge);
  const suburbs = node.localities ?? [];
  const focusBand = bandFor(node.type, node.serviceType);
  const choose = (asset) => onSelect
    ? <button className="network-name" onClick={() => onSelect(asset.id)}>{assetName(asset)}</button>
    : <Link className="network-name" to={inService(`/network/${asset.id}`, node.serviceType)}>{assetName(asset)}</Link>;
  const render = (edge) => <li key={`${edge.parentId}:${edge.childId}:${edge.relationType}`} className="connection-card supply-node">
    <div className="supply-node-top">
      <span className="asset-symbol" aria-hidden="true">{assetSymbol(edge.asset.type)}</span>
      <div className="supply-node-id">{choose(edge.asset)}<span className="supply-node-type">{typeLabel(edge.asset.type)}</span></div>
    </div>
    <span className="supply-node-rel">{linkLabel(edge.relationType)}</span>
    {edge.asset.live && <span className="diagram-live"><span className="dot live" />Live incident</span>}
    <button className="link small" onClick={() => setEvidence({ target: { parentId: edge.parentId, childId: edge.childId, relationType: edge.relationType }, title: `${assetName(edge.asset)} connection sources` })}>View connection sources</button>
  </li>;
  const suburbNode = (row) => <li key={row.localityId} className="suburb-node">
    {onSuburb
      ? <button className="network-name" onClick={() => onSuburb(row.localityId)}><Icon name="home" />{nice(row.locality.canonicalName)}</button>
      : <Link className="network-name" to={inService(`/suburb/${row.localityId}`, node.serviceType)}><Icon name="home" />{nice(row.locality.canonicalName)}</Link>}
    <span className="supply-node-rel">{linkLabel(row.relationType)}</span>
    <button className="link small" onClick={() => setEvidence({ target: { localityId: row.localityId }, title: `${nice(row.locality.canonicalName)} connection sources` })}>View connection sources</button>
  </li>;

  return <div className={`network-connections supply-diagram ${node.serviceType === 'WATER' ? 'service-water' : 'service-power'}`}>
    <p className="small diagram-lede">{copy.lede}</p>
    <div className="diagram-stage" aria-label={node.serviceType === 'WATER' ? 'Water supply hierarchy' : 'Electricity supply hierarchy'}>
      <section className="diagram-tier diagram-above">
        <TierHead step="01" title={copy.above} count={incoming.length} />
        {incoming.length ? <Bands items={incoming} service={node.serviceType} render={render} /> : <p className="diagram-gap">{copy.aboveEmpty}</p>}
      </section>
      {incoming.length > 0 && <Stem fan={incoming.length > 1} />}
      <section className="connection-current card diagram-focus">
        <span className="diagram-step">02</span>
        <span className="eyebrow">{node.type === 'SDC' ? 'Service centre' : 'Selected asset'}</span>
        <span className="asset-symbol">{assetSymbol(node.type)}</span>
        <h3>{assetName(node)}</h3>
        <p className="diagram-focus-type">{typeLabel(node.type)}{focusBand ? ` · ${focusBand.label}` : ''}</p>
        <p className="diagram-live">{node.live ? <><span className="dot live" />Live incident linked</> : 'No linked live incident'}</p>
        <button className="btn small" onClick={() => setEvidence(null)}>View asset sources</button>
      </section>
      {(outgoing.length > 0 || suburbs.length > 0) && <Stem />}
      {outgoing.length > 0 && <section className="diagram-tier diagram-below">
        <TierHead step="03" title={copy.below} count={outgoing.length} />
        <Bands items={outgoing} service={node.serviceType} render={render} />
      </section>}
      {outgoing.length > 0 && suburbs.length > 0 && <Stem fan={outgoing.length > 1} />}
      {outgoing.length === 0 && suburbs.length === 0 && <p className="diagram-gap">{copy.belowEmpty}</p>}
      {suburbs.length > 0 && <section className="diagram-tier diagram-suburbs">
        <TierHead step={outgoing.length > 0 ? '04' : '03'} title={copy.suburbs} count={suburbs.length} />
        <ExpandList items={suburbs} render={suburbNode} initial={16} step={24} />
      </section>}
    </div>
    {related.length > 0 && <section className="diagram-admin">
      <h3>Service administration ({related.length})</h3>
      <p className="small muted">Service centres coordinate repairs. Membership links are not a step in the supply path.</p>
      <ExpandList items={related} render={render} />
    </section>}
    <NetworkEvidence key={`${node.id}-${JSON.stringify(evidence)}`} nodeId={node.id} target={evidence?.target} title={evidence?.title} />
  </div>;
}

/** Assets that reach one suburb, banded from the top of the network down to the suburb. */
export function SuburbDiagram({ name, assets, service, onSelect }) {
  const depots = assets.filter((asset) => asset.type === 'SDC');
  const supply = assets.filter((asset) => asset.type !== 'SDC');
  const groups = groupByBand(supply, service);
  const water = service === 'WATER';
  return <div className={`supply-diagram ${water ? 'service-water' : 'service-power'}`}>
    <p className="small diagram-lede">{water ? 'Water assets linked to this suburb, from bulk supply down to local routes.' : 'Electricity assets linked to this suburb, from substations down to street equipment.'} Select an asset to open its own hierarchy.</p>
    <div className="diagram-stage" aria-label={water ? 'Water assets reaching this suburb' : 'Electricity assets reaching this suburb'}>
      {groups.map((group, index) => <section key={group.id} className="diagram-tier">
        <TierHead step={String(index + 1).padStart(2, '0')} title={group.label} count={group.items.length} />
        <ExpandList items={group.items} render={(asset) => <li key={asset.id} className="connection-card supply-node">
          <div className="supply-node-top">
            <span className="asset-symbol" aria-hidden="true">{assetSymbol(asset.type)}</span>
            <div className="supply-node-id">
              <button className="network-name" onClick={() => onSelect(asset.id)}>{nice(asset.name)}</button>
              <span className="supply-node-type">{typeLabel(asset.type)}</span>
            </div>
          </div>
          <span className="supply-node-rel">{linkLabel(asset.relationType)}</span>
          {asset.live && <span className="diagram-live"><span className="dot live" />Live incident</span>}
        </li>} />
        <Stem fan={group.items.length > 1} />
      </section>)}
      {!groups.length && <p className="diagram-gap">No supply assets are recorded for this suburb.</p>}
      <section className="connection-current card diagram-focus diagram-suburb-focus">
        <span className="eyebrow">Suburb</span>
        <h3><Icon name="home" /> {nice(name)}</h3>
        <p className="small muted">The assets above are linked to this suburb.</p>
      </section>
    </div>
    {depots.length > 0 && <section className="diagram-admin">
      <h3>Service centres ({depots.length})</h3>
      <p className="small muted">These depots coordinate repairs here. They are not a supply route.</p>
      <ul className="connection-items">{depots.map((asset) => <li key={asset.id} className="connection-card supply-node">
        <button className="network-name" onClick={() => onSelect(asset.id)}>{prettySdc(asset.name)}</button>
        <span className="supply-node-type">Service centre</span>
      </li>)}</ul>
    </section>}
  </div>;
}
