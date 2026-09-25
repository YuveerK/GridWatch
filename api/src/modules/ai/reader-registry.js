import { electricityReader } from './readers/electricity.reader.js';
import { waterReader } from './readers/water.reader.js';

const READERS = { ELECTRICITY: electricityReader, WATER: waterReader };

export function readerFor(serviceType) {
  return READERS[serviceType] ?? electricityReader;
}
