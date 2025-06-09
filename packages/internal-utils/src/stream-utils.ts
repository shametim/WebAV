import mp4box, { MP4File } from '@webav/mp4box.js';

/**
 * Automatically reads a stream and processes each data chunk.
 *
 * @template StreamType - The type of the ReadableStream.
 * @param {StreamType} stream - The stream to read from.
 * @param {object} callbacks - An object containing callback functions.
 * @param {function(DT): Promise<void>} callbacks.onChunk - A function called when a new data chunk is read.
 *   It receives the chunk as an argument and should return a Promise.
 *   `DT` is the data type of the chunks in the stream.
 * @param {function(): void} callbacks.onDone - A function called when all data chunks have been read.
 * @returns {function(): void} A function that, when called, stops reading the stream.
 *
 * @example
 * const stream = getSomeReadableStream(); // Assume this function returns a ReadableStream
 * const onChunk = async (chunk) => {
 *   console.log('New chunk:', chunk);
 *   // Process the chunk
 * };
 * const onDone = () => {
 *   console.log('Done reading stream');
 * };
 * const stopReading = autoReadStream(stream, { onChunk, onDone });
 * // Sometime later, if you need to stop before the stream ends:
 * // stopReading();
 */
export function autoReadStream<StreamType extends ReadableStream>(
  stream: StreamType,
  callbacks: {
    onChunk: StreamType extends ReadableStream<infer DataType>
      ? (chunk: DataType) => Promise<void>
      : never;
    onDone: () => void;
  },
): () => void {
  let stopped = false; // Flag to indicate if reading should be stopped

  // Asynchronous function to run the stream reading loop
  async function run() {
    const reader = stream.getReader(); // Get the stream reader

    // Loop until stopped or the stream is done
    while (!stopped) {
      const { value, done } = await reader.read(); // Read a chunk
      if (done) {
        // If the stream is done, call onDone and exit
        callbacks.onDone();
        return;
      }
      // Process the chunk using the provided onChunk callback
      await callbacks.onChunk(value);
    }

    // If stopped, release the reader lock and cancel the stream
    reader.releaseLock();
    await stream.cancel();
  }

  // Start the reading process and catch any potential errors
  run().catch(console.error);

  // Return a function to allow external stopping of the stream reading
  return () => {
    stopped = true;
  };
}

/**
 * Converts an MP4File object (from mp4box.js) into a ReadableStream.
 * This is useful for uploading the MP4 data to a server or saving it locally as a file.
 * The stream is chunked based on MP4 boxes, with an initial delay to ensure the 'moov' box (metadata)
 * is processed before streaming, making the output file valid.
 *
 * @param {MP4File} mp4File - The MP4File instance to convert.
 * @param {number} timeSliceMilliseconds - The interval in milliseconds at which to check for new MP4 boxes to stream.
 *                                 This controls the rate at which data is pushed into the stream.
 * @param {() => void} [onCancel] - An optional callback function that is triggered if the returned stream is cancelled by the consumer.
 * @returns {{ stream: ReadableStream<Uint8Array>, stop: (err?: Error) => void }} An object containing:
 *   - `stream`: A ReadableStream where each chunk is a Uint8Array representing part of the MP4 file.
 *   - `stop`: A function to proactively stop the streaming process from the producer side.
 *             It can optionally take an Error object to signal an error to the stream consumer.
 */
export function file2stream(
  mp4File: MP4File,
  timeSliceMilliseconds: number,
  onCancel?: () => void,
): {
  stream: ReadableStream<Uint8Array>;
  stop: (err?: Error) => void;
} {
  let intervalId: number = 0; // ID for the setInterval timer

  let sentBoxIndex = 0; // Index of the last MP4 box that has been sent to the stream
  const mp4Boxes = mp4File.boxes; // Array of MP4 boxes from the MP4File object

  let isFirstMoofWritten = false; // Flag to ensure 'moov' (or first 'moof') is written before other data

  // Function to create the next chunk of data to be enqueued in the stream.
  // It serializes MP4 boxes that haven't been sent yet.
  const createNextChunkBuffer = (): Uint8Array | null => {
    // Avoid writing data before 'moov' (or the first 'moof') is ready.
    // This ensures the output MP4 file is valid and playable.
    if (!isFirstMoofWritten) {
      // Check if any 'moof' box (movie fragment) is present.
      // In fragmented MP4s, 'moof' boxes appear before 'mdat' data for those fragments.
      // The presence of a 'moof' implies the initial metadata ('moov' or equivalent for fragmented) is available.
      if (mp4Boxes.find((box) => box.type === 'moof') != null) {
        isFirstMoofWritten = true;
      } else {
        // If no 'moof' yet, wait for more boxes to be processed by mp4box.js
        return null;
      }
    }
    // If all boxes have been sent, return null to indicate no more data.
    if (sentBoxIndex >= mp4Boxes.length) return null;

    const dataStream = new mp4box.DataStream(); // Use mp4box.js DataStream for writing boxes
    dataStream.endianness = mp4box.DataStream.BIG_ENDIAN;

    let currentIndex = sentBoxIndex;
    try {
      // Write all new boxes (from sentBoxIndex onwards) to the DataStream.
      for (; currentIndex < mp4Boxes.length; ) {
        mp4Boxes[currentIndex].write(dataStream);
        // @ts-ignore: Deleting to free memory, mp4box.js might reuse or expect this.
        delete mp4Boxes[currentIndex]; // Attempt to free memory, original box data no longer needed
        currentIndex += 1;
      }
    } catch (err) {
      // Handle errors during box writing, providing context about the problematic box.
      const errorBox = mp4Boxes[currentIndex];
      if (err instanceof Error && errorBox != null) {
        throw Error(
          `${err.message} | createNextChunkBuffer( boxType: ${
            errorBox.type
          }, boxSize: ${errorBox.size}, boxDataLen: ${
            // @ts-ignore
            errorBox.data?.length ?? -1
          })`,
        );
      }
      throw err; // Rethrow if not an Error instance or no box info
    }

    // After writing, release internal references in MP4File to reduce memory.
    // This is an unsafe operation that modifies the MP4File object.
    unsafeReleaseMP4BoxFile(mp4File);

    sentBoxIndex = mp4Boxes.length; // Update the index to the new length of boxes
    return new Uint8Array(dataStream.buffer); // Return the serialized boxes as a Uint8Array
  };

  let stopped = false; // Flag to indicate if the producer has stopped streaming
  let cancelled = false; // Flag to indicate if the consumer has cancelled the stream
  let finalizeStream: ((err?: Error) => void) | null = null; // Function to close or error the stream

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Periodically check for new MP4 boxes and enqueue them.
      intervalId = self.setInterval(() => {
        if (cancelled) return; // Do nothing if cancelled
        const dataChunk = createNextChunkBuffer();
        if (dataChunk != null) {
          controller.enqueue(dataChunk);
        }
      }, timeSliceMilliseconds);

      // finalizeStream is called when the producer wants to stop or an error occurs.
      finalizeStream = (err?: Error) => {
        clearInterval(intervalId); // Stop the interval timer
        mp4File.flush(); // Ensure any pending data in mp4box.js is processed

        if (err != null) {
          // If an error is provided, error the stream.
          if (!cancelled) controller.error(err);
          return;
        }

        // Enqueue any remaining data.
        const dataChunk = createNextChunkBuffer();
        if (dataChunk != null && !cancelled) {
          controller.enqueue(dataChunk);
        }

        // Close the stream if not cancelled.
        if (!cancelled) {
          controller.close();
        }
      };

      // If 'stop' was called before the stream even started, finalize immediately.
      if (stopped) finalizeStream();
    },
    cancel() {
      // Called by the stream consumer if they cancel the stream.
      cancelled = true;
      clearInterval(intervalId);
      onCancel?.(); // Call the provided onCancel callback
    },
  });

  return {
    stream,
    // Function for the producer to stop streaming.
    stop: (err?: Error) => {
      if (stopped) return; // Prevent multiple stops
      stopped = true;
      // If finalizeStream is already defined (stream has started), call it.
      // Otherwise, it will be called when 'start' is invoked.
      finalizeStream?.(err);
    },
  };
}

/**
 * Forcibly releases internal data from an MP4File object to reduce memory usage.
 * This operation is unsafe as it modifies the MP4File instance, potentially
 * rendering it unusable for further operations by mp4box.js.
 * Use only when the MP4File object is no longer needed after its binary data
 * has been extracted (e.g., into a stream).
 *
 * @param {MP4File} mp4File - The MP4File instance to modify.
 */
function unsafeReleaseMP4BoxFile(mp4File: MP4File): void {
  // Check if 'moov' box (main metadata) exists.
  if (mp4File.moov == null) return;

  // Clear samples from all tracks within the 'moov' box.
  // Samples can consume significant memory.
  for (let trackIndex = 0; trackIndex < mp4File.moov.traks.length; trackIndex++) {
    // @ts-ignore: MP4Sample[] is the correct type for samples.
    mp4File.moov.traks[trackIndex].samples = [];
  }
  // Clear 'mdat' (media data) boxes and 'moof' (movie fragment) boxes.
  // These arrays can also hold large amounts of data or references.
  mp4File.mdats = [];
  mp4File.moofs = [];
}
```
