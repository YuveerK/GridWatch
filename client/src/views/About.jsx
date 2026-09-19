import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { StatusBadge } from '../components/ui.jsx';
import { FAULT_LINE } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { Explainer } from './Network.jsx';

const STATUSES = [
  ['ACTIVE', 'City Power has reported a fault and repairs are still going on.'],
  ['PARTIALLY_RESTORED', 'Power is back in some places but not everywhere yet.'],
  ['RESTORED', 'City Power announced that supply is back on.'],
  ['PLANNED', 'Scheduled maintenance. The date and time come from City Power.'],
  ['STALE', 'City Power has said nothing for two days. It may be fixed, but nobody confirmed it.'],
  ['CLOSED', 'An old outage kept for history.'],
];

const TERMS = [
  ['SDC (Service Delivery Centre)', 'A regional depot. Johannesburg is split into about ten of them, each with its own repair teams.'],
  ['Substation', 'A large site that receives high-voltage power and sends it out on several circuits.'],
  ['Switching station', 'A site that routes power between circuits.'],
  ['Distributor / feeder', 'The circuit or cable that carries power from a substation to a group of streets.'],
  ['Mini-substation', 'A small street-level box that powers a few blocks.'],
  ['Load centre', 'A cluster of customers on one small part of a circuit. "Six load centres remain off" means a handful of small areas are still waiting.'],
];

export default function About() {
  useDocumentTitle('How it works');
  return (
    <div className="container page">
      <header className="page-head">
        <h1>How GridWatch works</h1>
        <p>An independent tool that makes City Power's many posts on X easier to follow. It isn't run by, or endorsed by, City Power.</p>
      </header>

      <div className="prose">
        <h2>The idea</h2>
        <p>City Power posts dozens of updates a day, and many of the details live inside images. It's hard to tell which posts are about your area or whether an outage is over. GridWatch reads every post, including the text inside the images, and gathers everything about one fault into a single outage with a timeline.</p>
      </div>

      <div className="cols-3" style={{ margin: '22px 0' }}>
        {[
          ['search', 'It reads', 'Every post and image from @CityPowerJhb is read for the place, the equipment and what is happening.'],
          ['network', 'It connects', 'Posts about the same fault are grouped, so you see one outage with its full history.'],
          ['bolt', 'It learns', 'Over time it learns which equipment feeds which suburbs, so it can guess when a post names none.'],
        ].map(([icon, t, d]) => (
          <div key={t} className="card card-pad"><div className="eyebrow" style={{ marginBottom: 12 }}><Icon name={icon} />{t}</div><p className="muted">{d}</p></div>
        ))}
      </div>

      <div className="prose"><h2>What the statuses mean</h2></div>
      <div className="card card-pad">
        <table className="legend-table"><tbody>
          {STATUSES.map(([s, d]) => <tr key={s}><td><StatusBadge status={s} /></td><td className="muted">{d}</td></tr>)}
        </tbody></table>
      </div>

      <div className="prose"><h2>How the power network fits together</h2></div>
      <Explainer />

      <div className="prose"><h2>Words you'll see</h2></div>
      <div className="card card-pad">
        <dl className="facts" style={{ gridTemplateColumns: 'minmax(150px, 220px) 1fr', gap: '16px 24px' }}>
          {TERMS.map(([t, d]) => (<Fragment key={t}><dt style={{ color: 'var(--ink)', fontWeight: 500 }}>{t}</dt><dd className="muted" style={{ fontWeight: 400 }}>{d}</dd></Fragment>))}
        </dl>
      </div>

      <div className="prose">
        <h2>What to keep in mind</h2>
        <ul>
          <li><b>It can lag or be wrong.</b> GridWatch only knows what City Power posts, and reading posts automatically isn't perfect. The original post is always one tap away on each update.</li>
          <li><b>"Likely areas" are guesses.</b> When a post names no suburb, we suggest places that equipment usually supplies. These are shown in grey with dashed outlines.</li>
          <li><b>Equipment lists are incomplete.</b> We learn the network only from outages that were reported, so quiet parts of the grid are missing.</li>
          <li><b>Your saved suburb stays in this browser.</b> GridWatch doesn't collect personal data or ask you to sign in.</li>
        </ul>
        <h2>Is your power out and it isn't listed?</h2>
        <p>Report it to City Power directly:</p>
      </div>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 26 }}>
          <div className="row"><Icon name="phone" /><div><div className="small muted">Call centre</div><b className="num">{FAULT_LINE.phone}</b></div></div>
          <div className="row"><Icon name="phone" /><div><div className="small muted">Toll-free</div><b className="num">{FAULT_LINE.freephone}</b></div></div>
          <div className="row"><Icon name="external" /><div><div className="small muted">Online</div><b>{FAULT_LINE.web}</b></div></div>
        </div>
      </div>
      <p className="small faint" style={{ marginTop: 18 }}>Contact details as published in City Power's own posts. <Link className="link" to="/">Back to the overview</Link></p>
    </div>
  );
}
