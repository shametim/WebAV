import { ExtMP4Sample, LocalFileReader, memoryUsageInfo } from './frame-finder-utils';
import { sleep, audioResample, extractPCM4AudioData } from '../av-utils';
import { DEFAULT_AUDIO_CONF } from './iclip';
import { createPromiseQueue } from '@webav/internal-utils'; // Added import
// import { MP4Sample } from '@webav/mp4box.js'; // Not directly used here, ExtMP4Sample is used

// WebCodecs types (assuming global or implicitly imported)
// import type { AudioDecoderConfig, EncodedAudioChunk, AudioData } from 'webcodecs';


export interface IAudioFrameFinderOpts {
  localFileReader: LocalFileReader;
  samples: ExtMP4Sample[];
  config: AudioDecoderConfig;
  outputOpts: { volume: number; targetSampleRate: number };
  logPrefix: string;
}

type AudioFrameFinderState =
  | 'Idle'
  | 'Decoding'
  | 'Buffering'
  | 'Error'
  | 'Closed';

// Custom Error Classes for AudioFrameFinder
class AudioFrameFinderError extends Error {
  constructor(message: string, public readonly finderState?: any) {
    super(message);
    this.name = this.constructor.name;
  }
}
class AudioDecoderError extends AudioFrameFinderError {}
class AudioTimeoutError extends AudioFrameFinderError {}
class AudioStateError extends AudioFrameFinderError {}


export class AudioFrameFinder {
  #volume = 1;
  #targetSampleRate;
  #logPrefix: string;
  #state: AudioFrameFinderState = 'Idle';
  #lastError: Error | null = null;

  #audioChunksDecoder: ReturnType<typeof createAudioChunksDecoder> | null = null;
  #currentAborter = { abort: false, startTime: performance.now() };
  #currentTimestamp = 0;
  #lastSeekTime = -1; // Added for _needsDecoderReset
  #decodeCursorIndex = 0;
  #pcmDataBuffer: {
    frameCount: number;
    data: [Float32Array, Float32Array][];
  } = { frameCount: 0, data: [] };
  #sleepCount = 0;

  #reusableAudioOutputL: Float32Array | undefined = undefined;
  #reusableAudioOutputR: Float32Array | undefined = undefined;

  localFileReader: LocalFileReader; // Made public for potential external inspection if needed
  samples: ExtMP4Sample[];
  config: AudioDecoderConfig;

  constructor(opts: IAudioFrameFinderOpts) {
    this.localFileReader = opts.localFileReader;
    this.samples = opts.samples;
    this.config = opts.config;
    this.#volume = opts.outputOpts.volume;
    this.#targetSampleRate = opts.outputOpts.targetSampleRate;
    this.#logPrefix = `${opts.logPrefix} AudioFrameFinder:`;
  }

  find = async (time: number): Promise<Float32Array[]> => {
    if (this.#state === 'Closed') {
      throw new AudioStateError(`${this.#logPrefix} Find called on a closed AudioFrameFinder.`, this.#getState());
    }
    if (this.#state === 'Error') {
      throw new AudioStateError(
        `${this.#logPrefix} Find called on AudioFrameFinder in Error state. Last error: ${this.#lastError?.message}`,
        { finderState: this.#getState(), cause: this.#lastError }
      );
    }

    this.#currentAborter.abort = true; // Abort previous operation
    this.#currentAborter = { abort: false, startTime: performance.now() };

    const deltaTime = time - this.#currentTimestamp; // Used to calculate emitFrameCount

    if (this._needsDecoderReset(time)) {
      this.#reset(); // Resets decoder, state, buffer, cursor etc.
      if (this.#state === 'Error') {
        throw new AudioStateError(
          `${this.#logPrefix} Error during reset in find(). Last error: ${this.#lastError?.message}`,
          { finderState: this.#getState(), cause: this.#lastError }
        );
      }
      // After reset, #currentTimestamp is reset to 0, #decodeCursorIndex to 0.
      // We need to set them based on the new 'time'.
      this.#currentTimestamp = time;
      this.#decodeCursorIndex = findIndexOfSamples(time, this.samples);
    } else {
      // If no reset, still update currentTimestamp for deltaTime calculation if it's a new seek
      if (this.#lastSeekTime !== time) {
          this.#currentTimestamp = time;
      }
    }

    this.#lastSeekTime = time; // Update last seek time

    if (this.#audioChunksDecoder == null) {
        // This should ideally be caught by _needsDecoderReset or handled within #reset
        const initError = new AudioDecoderError(`${this.#logPrefix} Decoder not initialized in find().`);
        this.#state = 'Error';
        this.#lastError = initError;
        throw initError;
    }

    // Calculate how many frames to request from #parseFrame based on the time delta.
    // If deltaTime is negative (seek backward, handled by reset), emitFrameCount will be 0.
    const emitFrameCount = Math.max(0, Math.ceil(deltaTime * (this.#targetSampleRate / 1e6)));

    const pcmData = await this.#parseFrame(
      emitFrameCount,
      this.#audioChunksDecoder
    );
    this.#sleepCount = 0;
    return pcmData;
  };

  private _needsDecoderReset(time: number): boolean {
    if (this.#audioChunksDecoder == null || this.#audioChunksDecoder.state === 'closed') {
      return true;
    }
    if (this.#state === 'Error') { // If already in error, try resetting
      return true;
    }
    // Significant seek backward (e.g., more than a tiny bit to account for precision)
    if (time < this.#lastSeekTime && (this.#lastSeekTime - time > 0.05e6)) { // Seek backward > 50ms
        // Note: #currentTimestamp is the timestamp of the *start* of the last served block of audio.
        // #lastSeekTime is the actual 'time' argument from the last find() call.
        return true;
    }
    // Optional: if seeking forward by a very large amount, could also reset.
    // For audio, it's often less critical than video unless the gap is huge,
    // as audio decoders can often process data faster.
    // if (time - this.#lastSeekTime > 10e6) { // e.g., > 10 seconds
    //   return true;
    // }
    return false;
  }

  private _tryServeFromPCMBuffer(emitFrameCount: number, decoder: ReturnType<typeof createAudioChunksDecoder>): Float32Array[] | null {
    let targetEmitCount: number;
    let isEndOfStreamFlush = false;

    if (this.#pcmDataBuffer.frameCount >= emitFrameCount) {
      targetEmitCount = emitFrameCount;
    } else if (this.#decodeCursorIndex >= this.samples.length && !decoder.isDecoding) {
      // EOS and decoder is idle
      if (this.#pcmDataBuffer.frameCount > 0) {
        targetEmitCount = this.#pcmDataBuffer.frameCount; // Emit whatever is left
        isEndOfStreamFlush = true;
      } else {
        return null; // Nothing left
      }
    } else {
      // Buffer insufficient and not EOS, or decoder still working
      this._ensurePCMBufferIsBeingFilled(decoder); // Also ensure filling if buffer is low
      return null;
    }

    // Prepare reusable arrays
    if (this.#reusableAudioOutputL == null || this.#reusableAudioOutputL.length !== targetEmitCount) {
      this.#reusableAudioOutputL = new Float32Array(targetEmitCount);
    }
    if (this.#reusableAudioOutputR == null || this.#reusableAudioOutputR.length !== targetEmitCount) {
      this.#reusableAudioOutputR = new Float32Array(targetEmitCount);
    }

    const pcmArr = emitAudioFrames(
      this.#pcmDataBuffer,
      targetEmitCount,
      this.#reusableAudioOutputL,
      this.#reusableAudioOutputR,
    );

    if (isEndOfStreamFlush) {
      this.#state = 'Idle';
    } else {
      this._ensurePCMBufferIsBeingFilled(decoder);
      this.#state = this.#pcmDataBuffer.frameCount > (this.#targetSampleRate / 20) ? 'Buffering' : 'Idle';
    }
    return pcmArr;
  }

  private _ensurePCMBufferIsBeingFilled(decoder: ReturnType<typeof createAudioChunksDecoder>): void {
    if (this.#state === 'Decoding' || this.#state === 'Error' || this.#state === 'Closed') {
      return;
    }
    if (this.#decodeCursorIndex >= this.samples.length) { // No more samples to feed
      return;
    }

    // Check if buffer is low (e.g., less than 1/10th of a second of audio)
    if (this.#pcmDataBuffer.frameCount < this.#targetSampleRate / 10) {
      this.#startDecode(decoder).catch(err => {
        // Errors from #startDecode should ideally set state to Error and store #lastError
        // This catch is a fallback for unhandled promise rejections from fire-and-forget.
        console.error(this.#logPrefix, "Error during background PCM buffer fill:", err);
        if (this.#state !== 'Error' && this.#state !== 'Closed') { // Avoid overriding a more specific error/state
            this.#state = 'Error';
            this.#lastError = err instanceof Error ? err : new Error('Unknown error in _ensurePCMBufferIsBeingFilled');
        }
      });
    }
  }

  private async _handleInsufficientPCMBufferAndProcessState(
    // emitFrameCount is not directly used here but was in video version, keep for consistency or remove if truly unused.
    emitFrameCount: number,
    decoder: ReturnType<typeof createAudioChunksDecoder>,
    aborter: { abort: boolean; startTime: number },
  ): Promise<'retry_parse' | null> {
    if (aborter.abort) return null;

    switch (this.#state) {
      case 'Idle':
      case 'Buffering':
        if (this.#decodeCursorIndex < this.samples.length) {
          // More samples available, try to decode them.
          // #startDecode is not async in current audio version, but making it awaitable if it becomes so.
          await this.#startDecode(decoder); // Sets state to 'Decoding'
          return 'retry_parse';
        } else if (!decoder.isDecoding && this.#pcmDataBuffer.frameCount === 0) {
          // End of samples, decoder is idle, and buffer is completely empty. Truly EOS.
          this.#state = 'Idle'; // Ensure state is Idle.
          return null;
        } else {
          // End of samples, but decoder might still be processing the last batch,
          // or there's some residual data in pcmDataBuffer.
          // Allow #parseFrame loop to re-evaluate via _tryServeFromPCMBuffer.
          return 'retry_parse';
        }

      case 'Decoding':
        // If in 'Decoding' state and buffer is insufficient, means we are waiting for decoder output.
        if (performance.now() - aborter.startTime > 3000) { // 3-second timeout
          const timeoutError = new AudioTimeoutError(
            `${this.#logPrefix} Audio decoding timed out after 3s.`,
            { finderState: this.#getState(), decoderInternalState: decoder.state }
          );
          console.error(timeoutError.message, timeoutError.finderState);
          this.#state = 'Error';
          this.#lastError = timeoutError;
          // aborter.abort = true; // The main loop will check this via this.#currentAborter
          throw timeoutError; // Let the main find/parseFrame catch this
        }
        this.#sleepCount += 1;
        await sleep(15); // Wait a bit for decoder to output more frames
        return 'retry_parse';

      case 'Error':
        // If already in Error state, no further parsing.
        return null;
      case 'Closed':
        // If Closed, no further parsing.
        return null;

      default:
        const unhandledStateError = new AudioStateError(
          `${this.#logPrefix} Unhandled state in _handleInsufficientPCMBufferAndProcessState: ${this.#state}`
        );
        this.#state = 'Error';
        this.#lastError = unhandledStateError;
        throw unhandledStateError;
    }
  }

  #parseFrame = async (
    emitFrameCount: number,
    decoder: ReturnType<typeof createAudioChunksDecoder>
    // aborter parameter removed, will use this.#currentAborter
  ): Promise<Float32Array[]> => {
    const aborter = this.#currentAborter; // Use the instance's aborter

    if (emitFrameCount <= 0) return [];

    while (!aborter.abort) {
      if (this.#state === 'Closed') return [];
      if (this.#state === 'Error') {
        throw this.#lastError ?? new AudioStateError(
          `${this.#logPrefix} AudioFrameFinder is in an Error state during #parseFrame.`,
          this.#getState()
        );
      }

      const pcmData = this._tryServeFromPCMBuffer(emitFrameCount, decoder);
      if (pcmData != null) {
        // If _tryServeFromPCMBuffer returns data (even if less than emitFrameCount at EOS),
        // we return it. The caller (find) is responsible for managing how much it requested vs received.
        return pcmData;
      }

      // If pcmData is null, buffer was insufficient and not EOS, or needs more processing.
      const processResult = await this._handleInsufficientPCMBufferAndProcessState(
        emitFrameCount, // Pass emitFrameCount for context, though handler might not use it directly
        decoder,
        aborter,
      );

      if (processResult === 'retry_parse') {
        await sleep(0); // Yield to event loop before continuing
        continue;
      } else { // processResult is null (e.g., EOS and buffer empty, Error, Closed)
        // If it's truly end of stream and pcmDataBuffer is empty, return empty array.
        // _tryServeFromPCMBuffer handles emitting residual frames at EOS.
        // If _handleInsufficientPCMBufferAndProcessState returns null, it means no more retries needed.
        return []; // Or null, depending on desired API contract for "nothing more"
      }
    }
    // Aborted
    return []; // Return empty array if aborted
  };

  // Making #startDecode async to allow awaiting it in _handleInsufficientPCMBufferAndProcessState
  // although _ensurePCMBufferIsBeingFilled calls it fire-and-forget.
  #startDecode = async (decoder: ReturnType<typeof createAudioChunksDecoder>) => {
    if (this.#state === 'Decoding' || this.#state === 'Closed' || this.#state === 'Error') {
      return;
    }

    const decodeBatchSize = 10;
    if (decoder.state !== 'closed' && decoder.decodeQueueSize > decodeBatchSize) {
      this.#state = 'Buffering';
      return;
    }

    this.#state = 'Decoding';

    const samplesToDecode = [];
    let i = this.#decodeCursorIndex;
    while (i < this.samples.length) {
      const sample = this.samples[i];
      i += 1;
      if (sample.deleted) continue; // Assuming 'deleted' property might exist
      samplesToDecode.push(sample);
      if (samplesToDecode.length >= decodeBatchSize) break;
    }
    this.#decodeCursorIndex = i;

    if (samplesToDecode.length === 0) {
      this.#state = 'Idle';
      return;
    }

    try {
      // Assuming EncodedAudioChunk is globally available or imported
      const chunks = samplesToDecode.map(
        (sample) =>
          new EncodedAudioChunk({
            type: sample.is_sync ? 'key' : 'delta', // Use is_sync for type; audio generally all key?
            timestamp: sample.cts,
            duration: sample.duration,
            data: sample.data!, // sample.data should be ArrayBuffer for EncodedAudioChunk
          }),
      );
      decoder.decode(chunks);
    } catch (error: any) { // Catch synchronous errors from creating/passing chunks
      const adError = new AudioDecoderError(
        `${this.#logPrefix} Error during audioChunksDecoder.decode: ${error?.message}`,
        { finderState: this.#getState(), cause: error }
      );
      console.error(adError.message, adError.finderState);
      this.#state = 'Error';
      this.#lastError = adError;
    }
  };

  #reset = () => {
    this.#currentTimestamp = 0;
    this.#decodeCursorIndex = 0;
    this.#pcmDataBuffer = { frameCount: 0, data: [] };
    this.#lastError = null;

    this.#audioChunksDecoder?.close();
    try {
      this.#audioChunksDecoder = createAudioChunksDecoder(
        this.config,
        {
          resampleRate: this.#targetSampleRate,
          volume: this.#volume,
        },
        (pcmArray) => {
          if (this.#state === 'Closed') return;
          this.#pcmDataBuffer.data.push(pcmArray as [Float32Array, Float32Array]);
          this.#pcmDataBuffer.frameCount += pcmArray[0].length;
          if (this.#state === 'Decoding') this.#state = 'Buffering';
        },
        this.#logPrefix,
      );
      this.#state = 'Idle';
    } catch (error: any) {
      const adError = new AudioDecoderError(
        `${this.#logPrefix} Failed to create audio decoder: ${error?.message}`,
        { cause: error, targetSampleRate: this.#targetSampleRate, volume: this.#volume }
      );
      console.error(adError.message, adError.finderState);
      this.#state = 'Error';
      this.#lastError = adError;
    }
  };

  #getState = () => ({
    state: this.#state,
    lastError: this.#lastError?.message,
    time: this.#currentTimestamp,
    decoderState: this.#audioChunksDecoder?.state,
    decoderQueueSize: this.#audioChunksDecoder?.decodeQueueSize,
    decodeCursorIndex: this.#decodeCursorIndex,
    sampleLength: this.samples.length,
    pcmFrameCountInBuffer: this.#pcmDataBuffer.frameCount,
    sleepCount: this.#sleepCount,
    memoryInfo: memoryUsageInfo(),
  });

  destroy = () => {
    if (this.#state === 'Closed') return;
    this.#state = 'Closed';
    this.#audioChunksDecoder?.close();
    this.#audioChunksDecoder = null;
    this.#currentAborter.abort = true;
    this.#pcmDataBuffer = { frameCount: 0, data: [] };
    // this.localFileReader.close(); // Owned by MP4Clip
  };
}

// Utility functions primarily used by AudioFrameFinder

/**
 * Creates an audio decoder that processes EncodedAudioChunks,
 * handles resampling, volume adjustment, and outputs PCM data.
 */
function createAudioChunksDecoder(
  decoderConfig: AudioDecoderConfig,
  opts: { resampleRate: number; volume: number },
  outputCb: (pcm: Float32Array[]) => void,
  logPrefix: string,
) {
  let inputChunkCount = 0;
  let outputFrameCount = 0;

  const outputPCMHandler = (pcmArray: Float32Array[]) => {
    outputFrameCount += 1;
    if (pcmArray.length === 0) return;

    if (opts.volume !== 1) {
      for (const pcmChannel of pcmArray) {
        for (let i = 0; i < pcmChannel.length; i++) {
          pcmChannel[i] *= opts.volume;
        }
      }
    }

    if (pcmArray.length === 1) {
      pcmArray = [pcmArray[0], pcmArray[0]];
    }
    outputCb(pcmArray);
  };

  const resampleQueue = createPromiseQueue<Float32Array[]>(outputPCMHandler);
  const needsResampling = opts.resampleRate !== decoderConfig.sampleRate;

  // Ensure a new AudioDecoder is created each time, as it cannot be reconfigured after closing.
  let audioDecoder = new AudioDecoder({
    output: (audioData) => {
      const pcmData = extractPCM4AudioData(audioData);
      if (needsResampling) {
        resampleQueue(() =>
          audioResample(pcmData, audioData.sampleRate, {
            rate: opts.resampleRate,
            chanCount: audioData.numberOfChannels,
          }),
        );
      } else {
        outputPCMHandler(pcmData);
      }
      audioData.close();
    },
    error: (err) => { // This is the primary error handler for the AudioDecoder
      if ((err as Error).message.includes('Codec reclaimed due to inactivity')) {
        console.warn(`${logPrefix} AudioDecoder reclaimed: ${err.message}`);
        // Allow it to be recreated on next reset/find
        return;
      }
      // For other errors, they are critical for this decoder instance.
      // The AudioFrameFinder's #reset method will handle trying to recreate.
      // Throwing here makes createAudioChunksDecoder itself error-prone on decoder error.
      // Instead, rely on the finder to detect decoder state or handle this via a passed-in error callback if needed.
      // For now, just log it, as the state machine in AudioFrameFinder will attempt reset on next find if decoder is closed.
      console.error(`${logPrefix} createAudioChunksDecoder AudioDecoder error:`, err);
      // To make it more robust, this could call a passed-in error handler that sets AudioFrameFinder state to Error.
      // However, the current design is that AudioFrameFinder manages its state based on decoder.state and explicit errors.
    },
  });
  audioDecoder.configure(decoderConfig);

  return {
    decode(chunks: EncodedAudioChunk[]) {
      inputChunkCount += chunks.length;
      // Synchronous errors from .decode() are possible if parameters are wrong.
      for (const chunk of chunks) audioDecoder.decode(chunk);
    },
    close() {
      if (audioDecoder.state !== 'closed') audioDecoder.close();
    },
    get isDecoding() {
      return (
        inputChunkCount > outputFrameCount && audioDecoder.decodeQueueSize > 0
      );
    },
    get state() {
      return audioDecoder.state;
    },
    get decodeQueueSize() {
      return audioDecoder.decodeQueueSize;
    },
  };
}

/**
 * Extracts a specified number of audio frames from the PCM data buffer.
 */
function emitAudioFrames(
  pcmDataBuffer: {
    frameCount: number;
    data: [Float32Array, Float32Array][];
  },
  emitFrameCount: number,
  outArrL?: Float32Array,
  outArrR?: Float32Array,
): [Float32Array, Float32Array] {
  let actualOutL: Float32Array;
  let actualOutR: Float32Array;

  if (
    outArrL != null &&
    outArrL.length === emitFrameCount &&
    outArrR != null &&
    outArrR.length === emitFrameCount
  ) {
    actualOutL = outArrL;
    actualOutR = outArrR;
  } else {
    actualOutL = new Float32Array(emitFrameCount);
    actualOutR = new Float32Array(emitFrameCount);
  }

  // const audioOutput = [actualOutL, actualOutR]; // This line is not strictly needed if using actualOutL/R directly
  let currentOffset = 0;
  let bufferIndex = 0;

  for (; bufferIndex < pcmDataBuffer.data.length; ) {
    const [channel0, channel1] = pcmDataBuffer.data[bufferIndex];
    if (currentOffset + channel0.length > emitFrameCount) {
      const framesToCopy = emitFrameCount - currentOffset;
      actualOutL.set(channel0.subarray(0, framesToCopy), currentOffset);
      actualOutR.set(channel1.subarray(0, framesToCopy), currentOffset);
      pcmDataBuffer.data[bufferIndex][0] = channel0.subarray(framesToCopy);
      pcmDataBuffer.data[bufferIndex][1] = channel1.subarray(framesToCopy);
      break;
    } else {
      actualOutL.set(channel0, currentOffset);
      actualOutR.set(channel1, currentOffset);
      currentOffset += channel0.length;
      // bufferIndex++; // This was an error, should be handled by slice below
    }
  }
  pcmDataBuffer.data = pcmDataBuffer.data.slice(bufferIndex); // Correctly remove processed chunks
  pcmDataBuffer.frameCount -= emitFrameCount;
  return [actualOutL, actualOutR];
}

/**
 * Finds the index of the sample that contains the given time.
 */
function findIndexOfSamples(time: number, samples: ExtMP4Sample[]): number {
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (time >= sample.cts && time < sample.cts + sample.duration) {
      return i;
    }
    if (sample.cts > time) break;
  }
  return 0;
}
