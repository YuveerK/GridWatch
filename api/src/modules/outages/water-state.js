/**
 * Water incident lifecycle is separate from the operating condition.
 * Pumping resumed or levels improving is RECOVERING, not RESTORED.
 */
export function foldWaterStatus(effect, current) {
  const supply = effect.customerSupply ?? null;
  const ws = effect.waterState ?? null;
  if (supply === 'RESTORED' || ws === 'NORMAL') return { status: 'RESTORED', waterState: 'NORMAL' };
  // A planned job keeps its lifecycle. The operating condition is recorded beside it, and the planned-window
  // sweep is what closes it. Folding it to ACTIVE would hide it from both that sweep and the unplanned quiet rule.
  if (effect.status === 'PLANNED') return { status: 'PLANNED', waterState: ws };
  if (supply === 'PARTIAL') return { status: 'PARTIALLY_RESTORED', waterState: ws && ws !== 'NORMAL' ? ws : 'PARTIAL_SUPPLY' };
  if (ws === 'PARTIAL_SUPPLY') return { status: 'PARTIALLY_RESTORED', waterState: 'PARTIAL_SUPPLY' };
  if (ws === 'RECOVERING') return { status: current === 'PARTIALLY_RESTORED' ? 'PARTIALLY_RESTORED' : 'ACTIVE', waterState: 'RECOVERING' };
  if (ws === 'LOW_PRESSURE' || ws === 'NO_SUPPLY' || ws === 'THROTTLED' || ws === 'CONSTRAINED') {
    return { status: 'ACTIVE', waterState: ws };
  }
  if (ws) return { status: current === 'RESTORED' || current === 'PARTIALLY_RESTORED' ? 'ACTIVE' : current ?? 'ACTIVE', waterState: ws };
  return { status: current ?? 'ACTIVE', waterState: null };
}

const PHRASES = [
  [/supply( has been| is)? restored|restored to all|supplying normally|back to normal/, { customerSupply: 'RESTORED', waterState: 'NORMAL' }],
  [/some areas restored|partially restored|still (have|has) low pressure|high-lying/, { customerSupply: 'PARTIAL', waterState: 'LOW_PRESSURE' }],
  [/outlets partially|partially open|partial supply/, { waterState: 'PARTIAL_SUPPLY' }],
  [/system is recovering|levels (are )?improving|pumping (has )?resumed|pumping restored|restored to full capacity|recovery at/, { waterState: 'RECOVERING' }],
  [/no water|no supply|water outage|interruption/, { waterState: 'NO_SUPPLY' }],
  [/poor pressure|low pressure/, { waterState: 'LOW_PRESSURE' }],
  [/critically low/, { waterState: 'CRITICAL' }],
  [/reservoir is empty|\bempty\b/, { waterState: 'EMPTY' }],
  [/no incoming|no inflow/, { waterState: 'NO_INCOMING_SUPPLY' }],
  [/no pumping/, { waterState: 'NO_PUMPING' }],
  [/throttl/, { waterState: 'THROTTLED' }],
  [/bypass/, { waterState: 'BYPASS' }],
];

/** Map a notice's own words onto a canonical water state. Explicit "supply restored" wins over "pumping resumed". */
export function waterStateFromText(text) {
  const t = String(text ?? '').toLowerCase();
  let customerSupply = null;
  let waterState = null;
  for (const [re, hit] of PHRASES) {
    if (!re.test(t)) continue;
    if (hit.customerSupply) customerSupply = hit.customerSupply;
    if (hit.waterState && !waterState) waterState = hit.waterState;
  }
  if (customerSupply === 'RESTORED') waterState = 'NORMAL';
  // Pumping or asset recovery is not customer restoration, even when the sentence also says "restored".
  if (waterState === 'RECOVERING' && customerSupply === 'RESTORED' && /pumping restored|restored to full capacity|recovery at/.test(t) && !/supply( has been| is)? restored|supplying normally|back to normal/.test(t)) {
    customerSupply = null;
  }
  return { customerSupply, waterState: waterState ?? 'UNKNOWN' };
}
