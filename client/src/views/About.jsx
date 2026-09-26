import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { StatusBadge } from '../components/ui.jsx';
import { useDocumentTitle } from '../lib/hooks.js';
import { WATER_STATE } from '../lib/api.js';
import { useMunicipality, useUtility } from '../lib/municipality.jsx';
import { Explainer } from './Network.jsx';

const STATUSES = [
  ['ACTIVE', 'The utility has reported a fault and repairs are still going on.'],
  ['PARTIALLY_RESTORED', 'Power is back in some places but not everywhere yet.'],
  ['RESTORED', 'The utility announced that supply is back on.'],
  ['PLANNED', 'Scheduled maintenance. The date and time come from the utility.'],
  ['STALE', 'The utility has said nothing for two days. It may be fixed, but nobody confirmed it.'],
  ['CLOSED', 'An old outage kept for history.'],
];

const WATER_STATUSES = [
  ['ACTIVE', 'Johannesburg Water has reported a supply problem that is not over. The badge says what customers face, from "No water supply" to "Low pressure".'],
  ['PARTIALLY_RESTORED', 'Supply is back in some areas but not all.'],
  ['RESTORED', 'Johannesburg Water said customers have water again. Only this closes an incident.'],
  ['PLANNED', 'Scheduled work. The date and time come from Johannesburg Water.'],
  ['STALE', 'Nothing has been posted for a while. Quiet is not the same as restored.'],
  ['CLOSED', 'An old incident kept for history.'],
];

// the conditions a live water incident is most often in
const WATER_CONDITIONS = ['NO_SUPPLY', 'LOW_PRESSURE', 'PARTIAL_SUPPLY', 'BYPASS', 'RECOVERING', 'STABLE'];

const WATER_TERMS = [
  ['Reservoir / tower', 'Stores water and keeps pressure up for the suburbs it supplies. When its level drops, those suburbs lose pressure or supply.'],
  ['Pump station', 'Lifts water to reservoirs and towers on higher ground. A power failure at a pump station often causes a water problem.'],
  ['Rand Water', 'The bulk supplier that sells water to Johannesburg Water. A problem upstream at Rand Water can affect many systems at once.'],
  ['Direct feed', 'Some suburbs are fed straight from a Rand Water connection rather than from a reservoir.'],
  ['Recovering', 'Pumping or levels are improving, but taps may still be dry or weak. GridWatch keeps the incident open until customer supply is confirmed.'],
  ['Bypass', 'A temporary route around a problem. It is not the normal supply path.'],
];

const TERMS = [
  ['SDC (Service Delivery Centre)', "A regional depot with its own repair teams. City Power splits Johannesburg into about ten of them; Tshwane's posts name a region or depot instead."],
  ['Substation', 'A large site that receives high-voltage power and sends it out on several circuits.'],
  ['Switching station', 'A site that routes power between circuits.'],
  ['Distributor / feeder', 'The circuit or cable that carries power from a substation to a group of streets.'],
  ['Mini-substation', 'A small street-level box that powers a few blocks.'],
  ['Load centre', 'A cluster of customers on one small part of a circuit. "Six load centres remain off" means a handful of small areas are still waiting.'],
];

export default function About() {
  useDocumentTitle('How it works');
  const { utility, Utility, accounts, contacts, single } = useUtility();
  const { service } = useMunicipality();
  const water = service === 'WATER';
  const who = single ? utility : 'each city';
  return (
    <div className="container page">
      <header className="page-head">
        <h1>How GridWatch works</h1>
        <p>An independent tool that makes {single ? `${utility}'s` : "the city utilities'"} many posts on X easier to follow. It isn't run by, or endorsed by, {single ? utility : 'any of them'}.</p>
      </header>

      <div className="prose">
        <h2>The idea</h2>
        <p>{single ? Utility : 'Each utility'} posts dozens of updates a day, and many of the details live inside images. It's hard to tell which posts are about your area or whether an outage is over. GridWatch reads every post, including the text inside the images, and gathers everything about one fault into a single outage with a timeline.</p>
      </div>

      <div className="cols-3" style={{ margin: '22px 0' }}>
        {[
          ['search', 'It reads', `Every post and image from ${accounts.map((a) => `@${a}`).join(' and ')} is read for the place, the equipment and what is happening.`],
          ['network', 'It connects', 'Posts about the same fault are grouped, so you see one outage with its full history.'],
          ['bolt', 'It learns', 'Over time it learns which equipment feeds which suburbs, so it can guess when a post names none.'],
        ].map(([icon, t, d]) => (
          <div key={t} className="card card-pad"><div className="eyebrow" style={{ marginBottom: 12 }}><Icon name={icon} />{t}</div><p className="muted">{d}</p></div>
        ))}
      </div>

      <div className="prose"><h2>What the statuses mean</h2></div>
      <div className="card card-pad">
        <table className="legend-table"><tbody>
          {(water ? WATER_STATUSES : STATUSES).map(([s, d]) => <tr key={s}><td><StatusBadge status={s} service={service} /></td><td className="muted">{d}</td></tr>)}
        </tbody></table>
      </div>

      {water && (
        <>
          <div className="prose">
            <h2>What a live water incident's condition means</h2>
            <p>Recovery is not restoration. Red means supply is off; amber means it is reduced, rerouted or recovering, and taps may still be dry or weak.</p>
          </div>
          <div className="card card-pad">
            <table className="legend-table"><tbody>
              {WATER_CONDITIONS.map((st) => <tr key={st}><td><StatusBadge status="ACTIVE" service="WATER" waterState={st} /></td><td className="muted">{WATER_STATE[st].long}.</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}

      <div className="prose"><h2>{water ? 'How the water network fits together' : 'How the power network fits together'}</h2></div>
      <Explainer service={service} />

      <div className="prose"><h2>Words you'll see</h2></div>
      <div className="card card-pad">
        <dl className="facts" style={{ gridTemplateColumns: 'minmax(150px, 220px) 1fr', gap: '16px 24px' }}>
          {(water ? WATER_TERMS : TERMS).map(([t, d]) => (<Fragment key={t}><dt style={{ color: 'var(--ink)', fontWeight: 500 }}>{t}</dt><dd className="muted" style={{ fontWeight: 400 }}>{d}</dd></Fragment>))}
        </dl>
      </div>

      <div className="prose">
        <h2>What to keep in mind</h2>
        <ul>
          <li><b>It can lag or be wrong.</b> GridWatch only knows what {who} posts, and reading posts automatically isn't perfect. The original post is always one tap away on each update.</li>
          <li><b>"Likely areas" are guesses.</b> When a post names no suburb, we suggest places that equipment usually supplies. These are shown in grey with dashed outlines.</li>
          <li><b>Equipment lists are incomplete.</b> We learn the network only from outages that were reported, so quiet parts of the grid are missing.</li>
          <li><b>Your saved suburb stays in this browser.</b> GridWatch doesn't collect personal data or ask you to sign in.</li>
        </ul>
        <h2>{water ? "Is your water off and it isn't listed?" : "Is your power out and it isn't listed?"}</h2>
        <p>Report it to {single ? utility : 'your city'} directly:</p>
      </div>
      {contacts.map(({ name, contact }) => (
        <div key={name} className="card card-pad" style={{ marginTop: 12 }}>
          {!single && <div className="small muted" style={{ marginBottom: 10 }}>{name}</div>}
          <div className="row" style={{ gap: 26 }}>
            <div className="row"><Icon name="phone" /><div><div className="small muted">Call centre</div><b className="num">{contact.phone}</b></div></div>
            {contact.freephone && <div className="row"><Icon name="phone" /><div><div className="small muted">Toll-free</div><b className="num">{contact.freephone}</b></div></div>}
            {contact.web && <div className="row"><Icon name="external" /><div><div className="small muted">Online</div><b>{contact.web}</b></div></div>}
          </div>
        </div>
      ))}
      <p className="small faint" style={{ marginTop: 18 }}>Contact details as published in {single ? `${utility}'s` : "each utility's"} own posts. <Link className="link" to="/">Back to the overview</Link></p>
    </div>
  );
}
