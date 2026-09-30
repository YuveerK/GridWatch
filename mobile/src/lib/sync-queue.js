/** Only the latest queued preference sync is applied. An older request cannot finish last. */
export function createSyncQueue() {
  let tail = Promise.resolve();
  let generation = 0;
  return {
    run(task) {
      const id = ++generation;
      const result = tail.then(async () => {
        if (id !== generation) return { obsolete: true };
        return task();
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
