// Give suburbs an approximate map position (a centre point). This now also happens automatically after every fetch
// (a few suburbs at a time); use this to catch up in bulk or to retry ones that failed.
//   npm run geocode              suburbs used by outages or equipment that have no position yet
//   npm run geocode -- --all     every suburb
//   npm run geocode -- --retry   also retry suburbs that could not be found before
import { prisma } from '../src/db/prisma.js';
import { placeLocalities } from '../src/modules/geo/geocode.service.js';

const res = await placeLocalities({
  all: process.argv.includes('--all'),
  retry: process.argv.includes('--retry'),
  download: true, // the monthly OpenStreetMap download is only ever done here
  patient: true, // wait out rate limits instead of giving up
  onProgress: (done, total) => done % 25 === 0 && console.log(`  ${done}/${total}`),
});
console.log(`${res.todo} suburbs needed a position. Placed from OpenStreetMap areas: ${res.osm}, from the geocoder: ${res.geocoder}, not found: ${res.none}, left for later: ${res.deferred}`);
await prisma.$disconnect();
