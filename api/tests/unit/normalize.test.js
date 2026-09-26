import { describe, expect, it } from 'vitest';
import { tailPlace, differsByLabel, infraKey, isBareVoltage, isGenericWaterAsset, isNotSuburbName, labelledEquipmentName, likelyTypo, localityKey, namedAfter, similarity } from '../../src/lib/normalize.js';

describe('isGenericWaterAsset', () => {
  it('a description is not an asset; a named pipe is', () => {
    for (const d of ['burst water pipe', 'burst pipe', 'affected pipeline', 'pipeline', 'water pipe', 'water network', '400mm pipe', '500 mm water pipeline', '1000mm diameter reservoir outlet pipe', 'main PRV station']) expect(isGenericWaterAsset(d), d).toBe(true);
    for (const n of ['Grosvenor Road', 'Lucas Place pipeline', 'HH2 interlink pipeline', 'Darter Street water pipe', 'Jangroentjie Avenue PRV', 'Glenvista Reservoir', 'Grand Central 600 Dia pipe to Glen Austin water supply line']) expect(isGenericWaterAsset(n), n).toBe(false);
  });
});

describe('namedAfter', () => {
  it('an asset named after a place, by whole words', () => {
    expect(namedAfter('Orange Farm High Level Reservoir', 'Orange Farm')).toBe(true);
    expect(namedAfter('Brixton 1 Reservoir', 'Brixton')).toBe(true);
    expect(namedAfter('President Park outlet', 'President Park')).toBe(true);
    expect(namedAfter('PD line Schuverburg', 'Schuverburg')).toBe(true);
    expect(namedAfter('Jacaranda secondary', 'Jacaranda')).toBe(true);
    expect(namedAfter('Lenasia High Level Reservoir', 'Yeoville')).toBe(false);
    expect(namedAfter('Lenasia High Level Reservoir', 'Len')).toBe(false);
    expect(namedAfter('Lenasia Reservoir', 'Lenasia South')).toBe(false);
  });
});

describe('normalize', () => {
  it('strips type words from infrastructure names', () => {
    expect(infraKey('Peter Road Substation')).toBe('peter road');
    expect(infraKey('Ruimsig Switching Station')).toBe('ruimsig');
    expect(infraKey('Clover Rd Distributor')).toBe('clover rd');
  });

  it('normalizes locality extensions and punctuation', () => {
    expect(localityKey('Beverley Ext.1 & 2')).toBe(localityKey('beverley extension1 and 2'));
    expect(localityKey('Lenasia South Ext 4')).toBe('lenasia south ext 4');
  });

  it('computes similarity', () => {
    expect(similarity('clover rd', 'clover rd')).toBe(1);
    expect(similarity('freedom park', 'freedom prk')).toBeGreaterThan(0.8);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('never treats equipment that differs by a short label or number as the same', () => {
    expect(differsByLabel('tshepisong a', 'tshepisong b')).toBe(true);
    expect(differsByLabel('clover rd 183', 'clover rd 182')).toBe(true);
    expect(differsByLabel('roosevelt park', 'roosevelt')).toBe(false);
    expect(differsByLabel('freedom park', 'freedom prk')).toBe(false);
  });

  it('keeps streets, facilities and companies out of the suburb list but accepts real suburbs', () => {
    for (const bad of ['Marshall Street West', 'Nasturtium Avenue', 'Kya Sand Rd 24', 'Transnet', 'Standby Oil 2', 'Civic Centre', 'Johannesburg Water', 'Sandringham Police Station', '12th to 13th Avenue', 'Newtown, Westgate', 'Elm/Valerie', 'Athol and Barnard', 'Ward 81', 'Prichard 153']) {
      expect(isNotSuburbName(bad), bad).toBe(true);
    }
    for (const good of ['Westdene', 'Houghton', 'Bryanston', 'Northcliff', 'Randjiespark', 'Kya Sand', 'Orange Grove East', 'Lenasia Extension 3', 'Bird Haven']) {
      expect(isNotSuburbName(good), good).toBe(false);
    }
  });

  it('finds the suburb after "in" in a street phrase', () => {
    expect(tailPlace('12th Avenue in Parktown North')).toBe('Parktown North');
    expect(tailPlace('Westdene')).toBeNull();
    expect(tailPlace('customers in')).toBeNull();
  });
});

describe('likely typos of equipment names', () => {
  it('one letter off, or the same letters scrambled with the same first and last letter', () => {
    expect(likelyTypo('klipfotein', 'klipfontein')).toBe(true);
    expect(likelyTypo('karzene', 'kazerne')).toBe(true);
    expect(likelyTypo('marshall street east', 'marshal street east')).toBe(true);
  });
  it('short names, different first letters and genuinely different names are not typos', () => {
    expect(likelyTypo('fort', 'forts')).toBe(false);
    expect(likelyTypo('bellairs north', 'prichard north')).toBe(false);
    expect(likelyTypo('kazerne', 'kazerne')).toBe(false);
    expect(likelyTypo('parkhurst', 'northcliff')).toBe(false);
  });
  it('a one-letter label difference is still equipment, not a typo (the caller checks differsByLabel)', () => {
    expect(differsByLabel('central a', 'central b')).toBe(true);
    expect(differsByLabel('panorama no 1', 'panorama no 2')).toBe(true);
  });
});

describe('electrical labels and voltages', () => {
  it('a line label belongs to its station, however it is written', () => {
    expect(labelledEquipmentName('D', 'Tshepisong')).toEqual({ name: 'Tshepisong D', bare: true });
    expect(labelledEquipmentName('Line D', 'Tshepisong')).toEqual({ name: 'Tshepisong D', bare: true });
    expect(labelledEquipmentName('Tshepisong Line D', null)).toEqual({ name: 'Tshepisong D', bare: false });
    expect(labelledEquipmentName('Feeder 2', 'Domkrag')).toEqual({ name: 'Domkrag 2', bare: true });
  });

  it('a bare label with no station is not stored; real names are untouched', () => {
    expect(labelledEquipmentName('Line C', null)).toBeNull();
    expect(labelledEquipmentName('Olivenhout', 'Northriding')).toEqual({ name: 'Olivenhout', bare: false });
    expect(labelledEquipmentName('Tshepisong Line A', null).name).toBe('Tshepisong A');
    expect(labelledEquipmentName('Airline Road', null).name).toBe('Airline Road');
  });

  it('a voltage class is not a piece of equipment', () => {
    for (const v of ['275kV', '132 kV', '33kV', '33 kV', '11kv']) expect(isBareVoltage(v), v).toBe(true);
    for (const n of ['132kV transformer R', 'Mamelodi 2', 'Line D']) expect(isBareVoltage(n), n).toBe(false);
  });
});

describe('only a part of a station needs a station', () => {
  it('a substation "K3" or a mini-substation "03962" is a site in its own right', () => {
    expect(labelledEquipmentName('K3', null, 'SUBSTATION')).toEqual({ name: 'K3', bare: false });
    expect(labelledEquipmentName('03962', null, 'MINI_SUBSTATION')).toEqual({ name: '03962', bare: false });
    expect(labelledEquipmentName('Line C', null, 'FEEDER')).toBeNull();
  });
});

describe('a shortened site number takes back its prefix from the notice', () => {
  const notice = 'Active Outage (s): TSS 65: Efforts to replace the vandalised transformer supplying Joburg Water premises along Side Road in Southdale are ongoing. 16:30';
  it('"65" in a notice that says "TSS 65" is TSS 65 (Southdale, 26 Sept)', () => {
    expect(labelledEquipmentName('65', null, 'OTHER', notice)).toEqual({ name: 'TSS 65', bare: false });
  });
  it('without such a prefix in the notice it stays as read, and a time like "16:30" is never a prefix', () => {
    expect(labelledEquipmentName('65', null, 'OTHER', 'Outage at site 65 in Southdale')).toEqual({ name: '65', bare: false });
    expect(labelledEquipmentName('30', null, 'OTHER', notice).name).toBe('30');
  });
});
