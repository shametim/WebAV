// This function sets up the Web Worker's behavior.
// It defines how the worker responds to messages from the main thread.
const setup = (): void => {
  // timerId stores the ID of the interval timer set within the worker.
  let timerId: number;

  // interval defines the time (in milliseconds) at which the worker will send messages to the main thread.
  // 16.6 ms corresponds to approximately 60 frames per second (FPS), a common refresh rate for displays.
  let interval: number = 16.6; // Approximately 60 FPS

  // self.onmessage is an event handler that gets triggered when the worker receives a message.
  self.onmessage = (e) => {
    // If the received message has an event property set to 'start':
    if (e.data.event === 'start') {
      // Clear any existing timer to prevent multiple intervals running simultaneously.
      self.clearInterval(timerId);
      // Set a new interval timer. Every `interval` milliseconds, it sends an empty message ({}) back to the main thread.
      timerId = self.setInterval(() => {
        self.postMessage({});
      }, interval);
    }

    // If the received message has an event property set to 'stop':
    if (e.data.event === 'stop') {
      // Clear the interval timer, stopping the worker from sending further messages.
      self.clearInterval(timerId);
    }
  };
};

// This function creates a new Web Worker.
// It encapsulates the worker's setup logic into a Blob and generates a URL for it.
const createWorker = (): Worker => {
  // Create a Blob containing the stringified version of the setup function, immediately invoked.
  // This makes the setup function the worker's main script.
  const blob = new Blob([`(${setup.toString()})()`]);
  // Create an object URL from the Blob. This URL can be used to instantiate the worker.
  const url = URL.createObjectURL(blob);
  // Create and return a new Worker instance using the generated URL.
  return new Worker(url);
};

// handlerMap is a Map data structure that stores timer handlers.
// The keys of the map are `groupId`s, which are derived from the requested timer interval.
// The values are Sets of handler functions associated with that `groupId`.
// This allows multiple handlers with similar timing requirements to be grouped and managed efficiently.
const handlerMap = new Map<number, Set<() => void>>();

// runCount is a counter that increments each time the Web Worker sends a message (approximately every 16.6ms when active).
// It's used in conjunction with the `groupId` to determine when specific handlers should be executed.
// For example, if a handler is registered with a `time` of 33.2ms, its `groupId` would be 2 (33.2 / 16.6).
// The handler would then be executed when `runCount % 2 === 0`.
let runCount = 1;

// worker holds the instance of the Web Worker. It's initialized to null.
let worker: Worker | null = null;
// Check if the global environment supports Web Workers.
if (globalThis.Worker != null) {
  // If Workers are supported, create a new worker instance.
  worker = createWorker();
  // Set up an event handler for messages received from the worker.
  worker.onmessage = () => {
    // Increment runCount each time a message is received from the worker.
    runCount += 1;
    // Iterate over all registered handler groups in handlerMap.
    for (const [k, v] of handlerMap) {
      // `k` is the groupId (derived from the timer interval).
      // If runCount is a multiple of the groupId `k`, it means it's time to execute the handlers in this group.
      if (runCount % k === 0) {
        // Iterate over all handler functions `fn` in the Set `v` associated with the current groupId.
        for (const fn of v) {
          // Execute the handler function.
          fn();
        }
      }
    }
  };
}

/**
 * This function provides a timer mechanism that aims to address the issue of timers
 * not firing (or being significantly delayed) when a web page is in the background.
 * It utilizes a Web Worker to maintain a consistent ticking interval.
 *
 * It behaves similarly to `setInterval`, but be aware that the timing (`time`) can have some deviation.
 * `setInterval` should be preferred if precise timing is critical and background operation is not a concern.
 *
 * @param handler - The function to be executed at each interval.
 * @param time - The desired interval time in milliseconds.
 * @returns A function that can be called to clear this specific timer.
 *
 * @see [JS Timer Duration Control Details (Chinese)](https://hughfenghen.github.io/posts/2023/06/15/timer-delay/) - Link to an article discussing timer delays.
 */
export const workerTimer = (
  handler: () => void,
  time: number,
): (() => void) => {
  // Calculate a groupId based on the desired `time`. This groups handlers with similar intervals.
  // The base interval of the worker is ~16.6ms.
  const groupId = Math.round(time / 16.6);

  // Retrieve the Set of handlers for this groupId, or create a new Set if it doesn't exist.
  const fns = handlerMap.get(groupId) ?? new Set();
  // Add the new handler to the Set.
  fns.add(handler);
  // Store the updated Set back in the handlerMap.
  handlerMap.set(groupId, fns);

  // If this is the very first handler being added to the handlerMap (i.e., handlerMap was empty and this is the first function in the first group),
  // send a 'start' message to the worker to begin its ticking.
  if (handlerMap.size === 1 && fns.size === 1) {
    worker?.postMessage({ event: 'start' });
  }

  // Return a cleanup function. When called, this function will remove the handler.
  return () => {
    // Remove the handler from its Set.
    fns.delete(handler);
    // If the Set becomes empty after removing the handler, delete the groupId from the handlerMap.
    if (fns.size === 0) handlerMap.delete(groupId);
    // If the handlerMap becomes completely empty (no active timers),
    // reset runCount and send a 'stop' message to the worker to cease its operations.
    if (handlerMap.size === 0) {
      runCount = 0;
      worker?.postMessage({ event: 'stop' });
    }
  };
};
```
