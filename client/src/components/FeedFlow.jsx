import { Link } from 'react-router-dom';
import { nice, prettySdc, typeLabel } from '../lib/api.js';
import Icon from './Icon.jsx';

const SHOW = 10;

function Names({ items, more }) {
  return (
    <div className="chips">
      {items.map((c) => (
        <Link key={c.key} to={c.to} className="chip">
          {c.live && <span className="dot live" style={{ width: 7, height: 7 }} title="Outage in progress" />}
          {c.label}
        </Link>
      ))}
      {more > 0 && <span className="chip soft">+{more} more</span>}
    </div>
  );
}

/**
 * The route power takes to reach this equipment and beyond it: service centre → substation → distributors → suburbs.
 * Built from what the utility's posts have shown, so it shows what is known, not the official diagram.
 */
export default function FeedFlow({ node }) {
  const upstream = node.chain.map((c) => ({ key: c.id, title: typeLabel(c.type), label: c.type === 'SDC' ? prettySdc(c.name) : nice(c.name), to: `/network/${c.id}` }));
  const kids = node.children.map((c) => ({ key: c.childId, type: c.child.type, label: nice(c.child.name), to: `/network/${c.childId}`, live: c.child.live }));
  const kidTypes = [...new Set(kids.map((k) => k.type))];
  const areas = node.localities.map((l) => ({ key: l.localityId, label: nice(l.locality.canonicalName), to: `/suburb/${l.localityId}` }));

  return (
    <ol className="fflow" aria-label="How power reaches this equipment and what it feeds">
      {upstream.map((u) => (
        <li key={u.key} className="fstep">
          <span className="eyebrow">{u.title}</span>
          <Link to={u.to} className="fname">{u.label}</Link>
          <span className="small faint">Feeds the next step</span>
        </li>
      ))}
      <li className="fstep here" aria-current="step">
        <span className="eyebrow">{typeLabel(node.type)} · you are here</span>
        <span className="fname">{node.type === 'SDC' ? prettySdc(node.name) : nice(node.name)}</span>
        <span className="small faint">{node.recentOutages.some((o) => o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED') ? 'Outage in progress' : 'No live outage'}</span>
      </li>
      {kids.length > 0 && (
        <li className="fstep">
          <span className="eyebrow">{kidTypes.map((t) => typeLabel(t) + 's').join(' · ')}</span>
          <Names items={kids.slice(0, SHOW)} more={kids.length - SHOW} />
          <span className="small faint">{kids.length} downstream</span>
        </li>
      )}
      {areas.length > 0 && (
        <li className="fstep">
          <span className="eyebrow">Suburbs reached</span>
          <Names items={areas.slice(0, SHOW)} more={areas.length - SHOW} />
          <span className="small faint">Named in outages involving this equipment</span>
        </li>
      )}
    </ol>
  );
}
