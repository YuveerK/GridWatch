export async function pollCityPower({ scheduler }) {
  return scheduler.poll();
}
