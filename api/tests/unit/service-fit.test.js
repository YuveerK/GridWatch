import { describe, expect, it } from 'vitest';
import { unsupportedService } from '../../src/modules/ai/service-fit.js';

describe('off-service posts', () => {
  it('treats a clear Tshwane water pipe burst as water on an electricity account', () => {
    expect(unsupportedService({
      serviceType: 'ELECTRICITY',
      text: '#WaterSupplyInterruption due to a burst 100mm water pipe at Puccini Street',
    })).toBe('WATER');
  });

  it('leaves a clear Tshwane power outage on the electricity path', () => {
    expect(unsupportedService({
      serviceType: 'ELECTRICITY',
      text: '#PowerOutage Mamelodi 1 Substation: a 132kV transformer trip',
    })).toBeNull();
  });

  it('leaves an ambiguous utility post for review', () => {
    expect(unsupportedService({
      serviceType: 'ELECTRICITY',
      text: 'Power supply has been restored.',
      result: { review_reason: 'No specific locations or equipment were mentioned in the post.' },
    })).toBeNull();
  });

  it('does not reclassify a Johannesburg Water post', () => {
    expect(unsupportedService({
      serviceType: 'WATER',
      text: 'Low pressure at the reservoir. Water supply interrupted.',
    })).toBeNull();
  });

  it('treats a reader note that the post is about water as off-service', () => {
    expect(unsupportedService({
      serviceType: 'ELECTRICITY',
      text: 'Teams are on site.',
      result: { review_reason: 'Post is about water, whereas the utility extractor processes electricity outages.' },
    })).toBe('WATER');
  });

  it('does not reclassify a City Power electricity post', () => {
    expect(unsupportedService({
      serviceType: 'ELECTRICITY',
      text: '#CityPowerOutages Hursthill SDC: Linden Distributor tripped',
    })).toBeNull();
  });
});

describe('threads on the Tshwane electricity account (26 Sept, Soshanguve pipeline repair)', () => {
  const head = '1/3 #WaterSupplyUpdate: Soshanguve Pipeline Repair The pipe was successfully installed, and the team proceeded with bolting the coupling.';

  it('a "#Water..." hashtag is water', () => {
    expect(unsupportedService({ serviceType: 'ELECTRICITY', text: '#WaterSupplyUpdate: Kruisfontein Reservoirs repairs progressing' })).toBe('WATER');
  });

  it('a continuation that no longer says water follows its thread', () => {
    expect(unsupportedService({ serviceType: 'ELECTRICITY', text: '2/3 The team then proceeded with the installation of the second seal.', threadText: head })).toBe('WATER');
  });

  it('without the thread it stays on the electricity path, and a continuation that names power equipment is power', () => {
    expect(unsupportedService({ serviceType: 'ELECTRICITY', text: '2/3 The team then proceeded with the installation of the second seal.' })).toBeNull();
    expect(unsupportedService({ serviceType: 'ELECTRICITY', text: '2/3 The substation transformer has been replaced.', threadText: head })).toBeNull();
  });

  it('a power thread does not make its replies water', () => {
    expect(unsupportedService({ serviceType: 'ELECTRICITY', text: '2/3 The team is still on site.', threadText: '#PowerOutage Mamelodi 1 Substation: transformer trip' })).toBeNull();
  });
});
