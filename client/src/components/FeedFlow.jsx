import { useState } from 'react';
import { Link } from 'react-router-dom';
import { nice, typeLabel } from '../lib/api.js';
import { inService } from '../lib/service.jsx';
import { assetSymbol, RELATION } from '../lib/network.js';
import NetworkEvidence from './NetworkEvidence.jsx';

function ExpandList({ items, render }) {
  const [limit, setLimit] = useState(10);
  return <><ul className="connection-items">{items.slice(0, limit).map(render)}</ul>{items.length > limit && <button className="btn small" onClick={() => setLimit(limit + 20)}>Show {Math.min(20, items.length - limit)} more ({items.length} total)</button>}{limit > 10 && <button className="btn small ghost" onClick={() => setLimit(10)}>Show fewer</button>}</>;
}

/** Branching neighbours, preserving every parent and typed edge. Re-root to explore another level. */
export default function FeedFlow({ node, onSelect, onSuburb }) {
  const [evidence, setEvidence] = useState(null);
  const parents = (node.parents ?? []).map((e) => ({ ...e, asset: e.parent, direction: 'in' }));
  const children = (node.children ?? []).map((e) => ({ ...e, asset: e.child, direction: 'out' }));
  const context = (e) => node.type === 'SDC' || e.asset.type === 'SDC' || ['PART_OF', 'LEGACY_PARENT'].includes(e.relationType);
  const incoming = parents.filter((e) => !context(e));
  const outgoing = children.filter((e) => !context(e));
  const related = [...parents, ...children].filter(context);
  const choose = (asset) => onSelect ? <button className="network-name" onClick={() => onSelect(asset.id)}>{nice(asset.name)}</button> : <Link className="network-name" to={inService(`/network/${asset.id}`, node.serviceType)}>{nice(asset.name)}</Link>;
  const render = (edge) => <li key={`${edge.parentId}:${edge.childId}:${edge.relationType}`} className="connection-card">
    <div className="row"><span className="asset-symbol" aria-hidden="true">{assetSymbol(edge.asset.type)}</span><div>{choose(edge.asset)}<div className="small muted">{typeLabel(edge.asset.type)}</div></div></div>
    <p className="small">{edge.direction === 'in' ? `${nice(edge.asset.name)} → ${nice(node.name)}` : `${nice(node.name)} → ${nice(edge.asset.name)}`}<br /><b>{node.type === 'SDC' || edge.asset.type === 'SDC' ? 'Service administration' : RELATION[edge.relationType] ?? 'Reported association'}</b></p>
    {edge.asset.live && <span className="badge tone-live">Live incident linked</span>}
    <button className="link small" onClick={() => setEvidence({ target: { parentId: edge.parentId, childId: edge.childId, relationType: edge.relationType }, title: `${nice(edge.asset.name)} connection sources` })}>View connection sources</button>
  </li>;
  return <div className="network-connections">
    <p className="small muted">Choose any connected asset to explore its neighbours. Arrows show the recorded relationship direction; lines do not trace pipes or cables. Multiple supply paths are shown separately.</p>
    <div className="connection-columns">
      <section><h3>Incoming supply connections ({incoming.length})</h3>{incoming.length ? <ExpandList key={`in-${node.id}`} items={incoming} render={render} /> : <p className="connection-unknown">Upstream supply unknown. No explicit supply connection has been recorded.</p>}</section>
      <section className="connection-current card card-pad"><span className="eyebrow">Selected asset</span><span className="asset-symbol">{assetSymbol(node.type)}</span><h3>{nice(node.name)}</h3><p>{typeLabel(node.type)}</p><button className="btn small" onClick={() => setEvidence(null)}>View asset sources</button><p className="small muted">Source confidence and current outage status are separate.</p></section>
      <section><h3>Outgoing supply connections ({outgoing.length})</h3>{outgoing.length ? <ExpandList key={`out-${node.id}`} items={outgoing} render={render} /> : <p className="connection-unknown">No explicit downstream supply connection recorded.</p>}</section>
    </div>
    {related.length > 0 && <section className="section"><h3>Associated assets and administration ({related.length})</h3><p className="small muted">Service centres coordinate repairs. Legacy associations and membership links do not establish a supply path.</p><ExpandList key={`related-${node.id}`} items={related} render={render} /></section>}
    {node.localities?.length > 0 && <section className="section"><h3>Linked suburbs ({node.localities.length})</h3><ExpandList key={`areas-${node.id}`} items={node.localities} render={(row) => <li key={row.localityId} className="connection-card"><div>{onSuburb ? <button className="network-name" onClick={() => onSuburb(row.localityId)}>{nice(row.locality.canonicalName)}</button> : <Link to={inService(`/suburb/${row.localityId}`, node.serviceType)}>{nice(row.locality.canonicalName)}</Link>}</div><span className="small muted">{RELATION[row.relationType] ?? 'Reported association'}</span><button className="link small" onClick={() => setEvidence({ target: { localityId: row.localityId }, title: `${nice(row.locality.canonicalName)} connection sources` })}>View connection sources</button></li>} /></section>}
    <NetworkEvidence key={`${node.id}-${JSON.stringify(evidence)}`} nodeId={node.id} target={evidence?.target} title={evidence?.title} />
  </div>;
}
