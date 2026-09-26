import { describe, expect, it } from 'vitest';
import { boardState, deliberateClosure, isThrottlingSchedule, isUnsplitWaterBoard, parseStatusBoard, statusBoardFaults, statusListLike, waterFaultItems } from '../../src/modules/ai/readers/water.reader.js';

// Real Johannesburg Water status boards, as transcribed by the reader (25 September 2026).
const COMMANDO = 'SYSTEM UPDATES 25 September 2026 - 19:20 Commando System Reservoir/ Tower Status Crosby Reservoir Supplying fairly. Crosby Pump Station Supplying failry. Brixton 1 Reservoir Supplying fairly. Brixton 1 Tower Supplying fairly. Hursthill 1 Reservoir On bypass. Supplying fairly. Poor pressure to no water may occur in some areas. Hursthill 2 Reservoir On bypass. Supplying fairly. Poor pressure to no water may occur in some areas. Indicators Adequate supply Critically low Fair supply On bypass Throttling in your area Vikela Amanzi, Protect Our Tomorrow';
const MIDRAND = 'Joburg Johannesburg Water SYSTEM UPDATES 25 September 2026 - 19:05 Midrand System Reservoir/ Tower Status Erand Reservoir Supplying adequately. Erand Tower On bypass. Supplying adequately. Grand Central Res Supplying adequately. Grand Central Tower Supplying adequately. Rabie Ridge Reservoir Supplying adequately. Rabie Ridge Tower Supplying adequately. President Park Reservoir Outlet closed, water demand management intervention in progress. President Park Tower On bypass. Supplying fairly. Diepsloot Reservoir Outlet closed, water demand management intervention in progress Steyn City Reservoir On bypass. Supplying fairly. Indicators Adequate supply Fair supply Throttling in your area Critically low On bypass Vikela Amanzi, Protect Our Tomorrow';
const DEEP_SOUTH_MORNING = 'JOBURG WATER SYSTEM UPDATES 25 September 2026 - 13:05 Deep South System Reservoir/ Tower Status Orange Farm Reservoir Supplying fairly. Declining Ennerdale Reservoir Supplying fairly. Lawley Reservoir Supplying fairly. Declining Lenasia Cosmos Reservoir Supplying fairly. Lenasia Hospital Hill Reservoir Supplying fairly. Lenasia Hospital Hill Pump Station Normal pumping. Lenasia High Level Reservoir Supplying fairly but low. Indicators Adequate supply Fair supply Throttling in your area Critically low On bypass Vikela Amanzi, Protect Our Tomorrow';
const SANDTON = 'SYSTEM UPDATES 25 September 2026 - 19:10 Sandton System Reservoir/ Tower Status Illovo Reservoir Supplying adequately. Illovo Tower Supplying adequately. Bryanston Reservoir Supplying adequately. Linbro Direct Feeds Supplying adequately. Dunkeld Reservoir On bypass. Supplying adequately. Linksfield Reservoir Supplying adequately. Indicators Adequate supply Critically low Fair supply On bypass Throttling in your area Vikela Amanzi, Protect Our Tomorrow';

const reading = (imageText, extra = {}) => ({ relevance: 'UPDATE', result: { relevance: 'GENERAL_NOTICE', water_state: 'CONSTRAINED', customer_supply: null, image_text: imageText, entities: [], localities: [], faults: [], ...extra } });

describe('parseStatusBoard', () => {
  it('reads every asset of a board with its type and status line', () => {
    const b = parseStatusBoard(COMMANDO);
    expect(b.system).toBe('Commando');
    expect(b.assets.map((a) => [a.name, a.type])).toEqual([
      ['Crosby Reservoir', 'RESERVOIR'], ['Crosby Pump Station', 'PUMP_STATION'], ['Brixton 1 Reservoir', 'RESERVOIR'],
      ['Brixton 1 Tower', 'WATER_TOWER'], ['Hursthill 1 Reservoir', 'RESERVOIR'], ['Hursthill 2 Reservoir', 'RESERVOIR'],
    ]);
    expect(b.assets[4].text).toBe('On bypass. Supplying fairly. Poor pressure to no water may occur in some areas.');
  });

  it('a status word opening the next line is never part of the next name ("Declining Ennerdale Reservoir")', () => {
    const names = parseStatusBoard(DEEP_SOUTH_MORNING).assets.map((a) => a.name);
    expect(names).toContain('Ennerdale Reservoir');
    expect(names).toContain('Lenasia Cosmos Reservoir');
    expect(names.some((n) => n.startsWith('Declining'))).toBe(false);
  });

  it('"Grand Central Res" is the Grand Central Reservoir, and direct feeds are direct feeds', () => {
    expect(parseStatusBoard(MIDRAND).assets.map((a) => a.name)).toContain('Grand Central Reservoir');
    expect(parseStatusBoard(SANDTON).assets.find((a) => a.name === 'Linbro Direct Feeds').type).toBe('DIRECT_FEED');
  });

  it('is null for anything that is not a status board', () => {
    expect(parseStatusBoard('Customer Notice - Progress Update – Glenvista Reservoir: repairs in progress.')).toBeNull();
    expect(parseStatusBoard(null)).toBeNull();
  });
});

describe('boardState: which lines are a problem for customers', () => {
  it.each([
    ['No pumping overnight.', 'NO_PUMPING', true],
    ['Outlet closed, water demand management intervention in progress.', 'OUTLET_CLOSED', true],
    ['On bypass. Supplying fairly. Poor pressure to no water may occur in some areas.', 'LOW_PRESSURE', true],
    ['Supplying fairly but low.', 'LOW', true],
    ['Overnight closure.', 'THROTTLED', true],
    ['On bypass. Supplying fairly.', 'BYPASS', true],
    ['On bypass. Supplying adequately.', 'BYPASS', false],
    ['Supplying fairly and improving.', 'RECOVERING', false],
    ['Supplying adequately.', 'NORMAL', false],
    ['Supplying fairly. Normal pumping.', 'NORMAL', false],
    ['Supplying fairly.', 'CONSTRAINED', false],
    ['Supplying failry.', 'CONSTRAINED', false],
  ])('%s -> %s', (line, state, problem) => {
    expect(boardState(line)).toEqual({ state, problem });
  });
});

describe('a board is split the same way every time, whatever the AI decided', () => {
  it('Commando 19:20: read as one unsplit notice, it still gives exactly the two Hursthill problems as their own faults', () => {
    const items = waterFaultItems(reading(COMMANDO, { relevance: 'UPDATE', entities: [{ type: 'RESERVOIR', name: 'Crosby Reservoir' }, { type: 'RESERVOIR', name: 'Hursthill 1 Reservoir' }, { type: 'RESERVOIR', name: 'Hursthill 2 Reservoir' }] }));
    expect(items.map((i) => i.extraction.result.entities.map((e) => e.name))).toEqual([['Hursthill 1 Reservoir'], ['Hursthill 2 Reservoir']]);
    expect(items.every((i) => i.fromDigest && i.extraction.relevance === 'UPDATE' && i.extraction.result.water_state === 'LOW_PRESSURE')).toBe(true);
    expect(isUnsplitWaterBoard(reading(COMMANDO).result)).toBe(false);
  });

  it('read as a "general notice" with 16 faults of its own, the board still decides: the same problems, nothing more', () => {
    const aiFaults = Array.from({ length: 16 }, (_, i) => ({ water_state: 'CONSTRAINED', entities: [{ type: 'RESERVOIR', name: `R${i}` }], localities: [] }));
    const a = waterFaultItems(reading(MIDRAND, { relevance: 'GENERAL_NOTICE', faults: aiFaults }));
    const b = waterFaultItems(reading(MIDRAND, { relevance: 'UPDATE', faults: [] }));
    const names = (items) => items.map((i) => i.extraction.result.entities[0].name);
    expect(names(a)).toEqual(['President Park Reservoir', 'President Park Tower', 'Diepsloot Reservoir', 'Steyn City Reservoir']);
    expect(names(b)).toEqual(names(a));
  });

  it('a board where everything is fine is a notice: no incidents', () => {
    const items = waterFaultItems(reading(SANDTON, { relevance: 'UPDATE' }));
    expect(items).toHaveLength(1);
    expect(items[0].extraction.relevance).toBe('GENERAL_NOTICE');
    expect(statusBoardFaults({ image_text: SANDTON })).toEqual([]);
  });

  it('a board fault never claims customer restoration and names no suburb it was not given', () => {
    const [fault] = waterFaultItems(reading(COMMANDO));
    expect(fault.extraction.result.customer_supply).toBeNull();
    expect(fault.extraction.result.status).not.toBe('RESTORED');
    expect(fault.extraction.result.localities).toEqual([]);
  });
});

describe('the daily "Management of Systems" throttling schedule is always a notice', () => {
  // 25 September 2026, as transcribed by the reader
  const SCHEDULE = 'JOBURG WATER MANAGEMENT OF SYSTEMS Throttling is scheduled to commence at around 18:00 on 25 September 2026 and will conclude at around 05:00am on 26 September 2026. The degree of restrictions will vary, with reductions ranging from 50% to 100%. Reservoirs and towers subjected to throttling daily Orange Farm High Level Reservoir, Lenasia High Level Reservoir, Lenasia Hospital Hill Reservoir, President Park outlet (networks).';
  const assets = ['Orange Farm High Level Reservoir', 'Lenasia High Level Reservoir', 'Lenasia Hospital Hill Reservoir'].map((name) => ({ type: 'RESERVOIR', name }));
  const schedule = (localities, extra = {}) => ({ image_text: SCHEDULE, entities: assets, localities: localities.map((name) => ({ name })), faults: [], ...extra });

  it('names reservoirs and no suburbs (25 Sept): a notice, whatever the reading made of it', () => {
    expect(isThrottlingSchedule(schedule([]))).toBe(true);
    const threeFaults = schedule([], { faults: assets.map((e) => ({ water_state: 'THROTTLED', entities: [e], localities: [] })) });
    const items = waterFaultItems({ relevance: 'PLANNED_OUTAGE', result: { ...threeFaults, relevance: 'PLANNED_OUTAGE' } });
    expect(items).toHaveLength(1);
    expect(items[0].extraction.relevance).toBe('GENERAL_NOTICE');
    expect(isUnsplitWaterBoard(threeFaults)).toBe(false);
  });

  it('"suburbs" that are the reservoirs\' names echoed back, one of them an asset the reader dropped (11 Sept), still a notice', () => {
    expect(isThrottlingSchedule(schedule(['Orange Farm', 'Lenasia', 'President Park']))).toBe(true);
  });

  it('a notice naming real affected suburbs is not the schedule', () => {
    expect(isThrottlingSchedule(schedule(['Melville', 'Emmarentia', 'Greenside']))).toBe(false);
    expect(isThrottlingSchedule({ image_text: 'Customer Notice: throttling at Hursthill 2 Reservoir affecting Melville', entities: [], localities: [] })).toBe(false);
  });
});

describe('a board line says whether a closure is deliberate', () => {
  it.each([
    ['Overnight closure.', true],
    ['No pumping overnight.', true],
    ['Outlet closed, water demand management intervention in progress.', true],
    ['No pumping.', false],
    ['On bypass. Supplying fairly. Poor pressure to no water may occur in some areas.', false],
  ])('%s -> %s', (text, deliberate) => {
    expect(deliberateClosure(text)).toBe(deliberate);
  });

  it('is carried on the fault, for the linker', () => {
    const faults = statusBoardFaults({ image_text: 'SYSTEM UPDATES 23 September 2026 - 17:45 Sandton System Reservoir/ Tower Status Illovo Reservoir Overnight closure Robertville Reservoir No pumping. Indicators' });
    expect(faults.map((f) => [f.entities[0].name, f.planned_closure])).toEqual([['Illovo Reservoir', true], ['Robertville Reservoir', false]]);
  });
});

describe('only a status list is a board', () => {
  it('a board whose transcription dropped "Status" (Soweto, 25 Sept 13:15) is still parsed', () => {
    const t = 'SYSTEM UPDATES 25 September 2026 - 13:15 Soweto System Reservoir/ Tower Supplying fairly. Doornkop Reservoir Supplying fairly. Jabulani Reservoir On bypass. Supplying fairly. Zondi Tower On bypass. Supplying fairly. Indicators Adequate supply';
    expect(statusBoardFaults({ image_text: t }).map((f) => f.entities[0].name)).toEqual(['Jabulani Reservoir', 'Zondi Tower']);
  });

  it('a written customer notice about one system event is not a board, even when it walks through each asset (Commando, 26 Sept)', () => {
    const notice = 'Customer Notice Status update of Commando system. Challenges with incoming supply affected pumping from Crosby Pump Station to the Brixton Reservoirs. Brixton 1 Reservoir: supplying fairly. Brixton 1 Tower: supplying fairly. Hursthill 1 and Hursthill 2 Reservoirs: both remain on bypass.';
    const r = { image_text: notice, entities: ['Crosby Pump Station', 'Brixton 1 Reservoir', 'Brixton 1 Tower', 'Hursthill 1 Reservoir'].map((name) => ({ type: 'RESERVOIR', name })), localities: [], faults: [] };
    expect(statusListLike(notice)).toBe(true);
    expect(isUnsplitWaterBoard(r)).toBe(false);
  });

  it('an unparsed status list is still set aside rather than made one giant incident', () => {
    const list = 'Illovo Reservoir Supplying adequately. Bryanston Reservoir Supplying adequately. Morningside Reservoir Supplying fairly. Linksfield Reservoir On bypass.';
    const r = { image_text: list, entities: ['Illovo Reservoir', 'Bryanston Reservoir', 'Morningside Reservoir', 'Linksfield Reservoir'].map((name) => ({ type: 'RESERVOIR', name })), localities: [], faults: [] };
    expect(isUnsplitWaterBoard(r)).toBe(true);
  });
});
