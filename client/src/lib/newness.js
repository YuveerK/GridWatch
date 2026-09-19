/** Was this stored at or after the start of the latest fetch that brought new posts? */
export function isNewSince(ingestedAt, lastBatch) {
  if (!ingestedAt || !lastBatch?.startedAt) return false;
  return new Date(ingestedAt).getTime() >= new Date(lastBatch.startedAt).getTime();
}
