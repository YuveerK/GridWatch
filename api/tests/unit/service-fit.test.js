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
