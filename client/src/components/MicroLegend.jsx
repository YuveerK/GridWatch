import { statusMeta } from '../lib/api.js';
import Icon from './Icon.jsx';
import { InfoTip } from './ui.jsx';

export const STATUS_HELP = {
  ACTIVE: 'City Power has reported a fault and repairs are not finished.',
  PARTIALLY_RESTORED: 'Some suburbs have power again; others are still waiting.',
  RESTORED: 'City Power reported that supply is back.',
  PLANNED: 'Scheduled maintenance with an announced date.',
  STALE: 'No news for 2 days. It may be fixed, but City Power has not said.',
};

/** The colour key, small enough to sit right above what it explains. Colour is never the only signal: icon and word too. */
export default function MicroLegend({ items = ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'], help = true }) {
  return (
    <div className="micro-legend-wrap">
      <ul className="micro-legend" aria-label="What the colours mean">
        {items.map((s) => {
          const m = statusMeta(s);
          return <li key={s} className={`tone-${m.tone}`}><Icon name={m.icon} />{m.label}</li>;
        })}
      </ul>
      {help && (
        <InfoTip label="the colours">
          <b>What the colours mean</b>
          <span style={{ display: 'block', marginTop: 6 }}>
            {['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED', 'STALE'].map((s) => (
              <span key={s} style={{ display: 'block', marginTop: 4 }}><b>{statusMeta(s).label}:</b> {STATUS_HELP[s]}</span>
            ))}
          </span>
        </InfoTip>
      )}
    </div>
  );
}
