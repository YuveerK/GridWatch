import Icon from './Icon.jsx';
import { useService } from '../lib/service.jsx';

const CHOICES = [
  ['ELECTRICITY', 'Power', 'bolt'],
  ['WATER', 'Water', 'drop'],
];

export default function ServiceSwitcher() {
  const { service, setService } = useService();
  return (
    <div className="seg service-switch" role="group" aria-label="Service">
      {CHOICES.map(([value, label, icon]) => (
        <button key={value} type="button" aria-pressed={service === value} onClick={() => setService(value)}>
          <Icon name={icon} />
          {label}
        </button>
      ))}
    </div>
  );
}
