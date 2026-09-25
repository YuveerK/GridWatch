import Icon from './Icon.jsx';

/** A persistent, readable utility cue. Status colours remain independent. */
export default function ServiceIdentity({ service = 'ELECTRICITY', compact = false }) {
  const water = service === 'WATER';
  return (
    <span className={`service-identity ${water ? 'service-water' : 'service-power'}${compact ? ' compact' : ''}`}>
      <Icon name={water ? 'drop' : 'bolt'} />
      <span>{water ? 'Water' : 'Electricity'}</span>
    </span>
  );
}
