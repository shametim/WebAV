// packages/internal-utils/src/promise-utils.ts
export function createPromiseQueue<T extends any>(onResult: (data: T) => void) {
  const resultsCache: T[] = [];
  let waitingIndex = 0;

  function storeAndEmit(result: T, emitIndex: number) {
    resultsCache[emitIndex] = result;
    tryEmit();
  }

  function tryEmit() {
    const result = resultsCache[waitingIndex];
    if (result == null) return;
    onResult(result);

    waitingIndex += 1;
    tryEmit();
  }

  let addIndex = 0;
  return (task: () => Promise<T>) => {
    const emitIndexForTask = addIndex;
    addIndex += 1;
    task()
      .then((result) => storeAndEmit(result, emitIndexForTask))
      .catch((err) => storeAndEmit(err as T, emitIndexForTask)); // Ensure errors are also passed as T
  };
}
