import { sleep } from '../av-utils';
import { ExtMP4Sample, LocalFileReader, memoryUsageInfo } from './frame-finder-utils';
import { OPFSToolFile } from 'opfs-tools'; // For type if needed by videoSamplesToEncodedChunks directly
// Standard WebCodecs types (usually global or imported from 'webcodecs')
// For the purpose of this refactor, assume they are available globally or via an implicit import.
// import type { VideoDecoderConfig, EncodedVideoChunk, VideoFrame, HardwarePreference } from 'webcodecs';
// MP4Sample is used if any function here directly processes it before ExtMP4Sample stage
// import { MP4Sample } from '@webav/mp4box.js';


// Type Definitions specific to VideoFrameFinder
export interface IVideoFrameFinderOpts {
  localFileReader: LocalFileReader;
  samples: ExtMP4Sample[];
  config: VideoDecoderConfig; // This is a WebCodecs type
  logPrefix: string;
}

type VideoFrameFinderState =
  | 'Idle'
  | 'Seeking'
  | 'Decoding'
  | 'Buffering'
  | 'Error'
  | 'Closed';

// Custom Error Classes
class VideoFrameFinderError extends Error {
  constructor(message: string, public readonly finderState?: any) {
    super(message);
    this.name = this.constructor.name;
  }
}
class DecoderSetupError extends VideoFrameFinderError {}
class DecodingError extends VideoFrameFinderError {}
class TimeoutError extends VideoFrameFinderError {}
class StateError extends VideoFrameFinderError {}
class SampleReadError extends VideoFrameFinderError {}

let CLIP_ID = 0; // This was global in mp4-clip.ts, used in #getState. Consider if it's needed or should be passed.
                 // For now, keep it here if #getState is moved as is.
                 // If #getState is simplified or this info isn't critical, it can be removed.
                 // Let's remove it for now from here, MP4Clip can pass its own ID if needed for logging.

export class VideoFrameFinder {
  #decoder: VideoDecoder | null = null;
  #logPrefix: string;
  #state: VideoFrameFinderState = 'Idle';
  #lastError: Error | null = null;

  localFileReader: LocalFileReader;
  samples: ExtMP4Sample[];
  config: VideoDecoderConfig;

  #currentTimestamp = 0;
  #currentAborter = { abort: false, startTime: performance.now() };
  #lastVideoFrameDuration = 0;
  #decodeCursorIndex = 0;
  #decodedVideoFrames: VideoFrame[] = [];
  #outputFrameCount = 0;
  #inputChunkCount = 0;
  #sleepCount = 0;
  // lastSeekTime and lastSeekMode are to help _needsDecoderReset determine if a new seek is significantly different
  #lastSeekTime = -1;
  #lastSeekMode: 'accurate' | 'fast' = 'accurate';


  constructor(opts: IVideoFrameFinderOpts) {
    this.localFileReader = opts.localFileReader;
    this.samples = opts.samples;
    this.config = opts.config; // This should be the VideoDecoderConfig with hardwareAcceleration preference
    this.#logPrefix = `${opts.logPrefix} VideoFrameFinder:`;
  }

  find = async (time: number, mode: 'accurate' | 'fast' = 'accurate'): Promise<VideoFrame | null> => {
    if (this.#state === 'Closed') {
      throw new StateError(`${this.#logPrefix} Find called on a closed VideoFrameFinder.`, this.#getState());
    }
    if (this.#state === 'Error') {
      throw new StateError(
        `${this.#logPrefix} Find called on VideoFrameFinder in Error state. Last error: ${this.#lastError?.message}`,
        { finderState: this.#getState(), cause: this.#lastError }
      );
    }

    this.#currentAborter.abort = true;
    this.#currentAborter.abort = true; // Abort any ongoing operation from a previous find call
    this.#currentAborter = { abort: false, startTime: performance.now() };
    this.#currentTimestamp = time;

    if (this._needsDecoderReset(time, mode)) {
      // #reset will close the current decoder if it exists.
      // It then creates a new one and configures it.
      // #reset also sets the state to 'Seeking' initially, then to 'Idle' or 'Error'.
      await this.#reset(time); // Make reset async if it performs async operations like closing decoder
    }
    // After reset, or if no reset was needed, #decoder should be valid unless an error occurred in #reset.
    if (this.#state === 'Error') {
       throw this.#lastError ?? new StateError(`${this.#logPrefix} Finder in error state post-reset or pre-find.`);
    }
    if (this.#decoder == null || this.#decoder.state === 'closed' || this.#decoder.state === 'unconfigured') {
        // This case should ideally be handled by #reset correctly setting up the decoder or throwing.
        // If we reach here, it's an unexpected state.
        const criticalError = new DecoderSetupError(
            `${this.#logPrefix} Decoder not ready for find. State: ${this.#decoder?.state}`,
            this.#getState()
        );
        this.#state = 'Error';
        this.#lastError = criticalError;
        throw criticalError;
    }

    // Update last seek time and mode for the next _needsDecoderReset check
    this.#lastSeekTime = time;
    this.#lastSeekMode = mode;

    const videoFrame = await this.#parseFrame(
      time,
      this.#decoder!, // Should be valid here
      mode,
    );
    this.#sleepCount = 0;
    return videoFrame;
  };

  private _needsDecoderReset(time: number, mode: 'accurate' | 'fast'): boolean {
    if (this.#decoder == null || this.#decoder.state === 'closed') {
      return true;
    }
    // If state is Error, a reset is usually needed to try again.
    if (this.#state === 'Error') {
        return true;
    }

    // Significant seek backward:
    // If current buffer starts way after 'time', or if 'time' is before the earliest buffered frame.
    // The #currentTimestamp tracks the target time of the current/last successful #parseFrame or #reset.
    // If the new 'time' is significantly before the last seek time, a reset is needed.
    if (time < this.#lastSeekTime && (this.#lastSeekTime - time > 1e6)) { // Seek backward more than 1s
        return true;
    }

    // Significant seek forward:
    // Accurate mode: if seeking forward more than a small amount (e.g., beyond current GoP or few seconds)
    // Fast mode: if seeking forward more than a larger amount (e.g., many GoPs or tens of seconds)
    const timeDiff = time - this.#lastSeekTime;
    if (mode === 'accurate' && timeDiff > 3e6) { // More than 3s for accurate
      return true;
    }
    if (mode === 'fast' && timeDiff > 10e6) { // More than 10s for fast
      return true;
    }

    // If the mode changes from fast to accurate, and the new time is not "very close" to the last seek time
    if (this.#lastSeekMode === 'fast' && mode === 'accurate') {
        if (Math.abs(time - this.#lastSeekTime) > 0.5e6) { // If time changed by more than 0.5s
            return true;
        }
    }

    // If the decoder is unconfigured (e.g. after a codec reclaim error that wasn't fully handled by reset)
    if (this.#decoder.state === 'unconfigured') {
        return true;
    }

    // Check if the requested time is outside the range of currently buffered/decoding GoP.
    // This requires knowing the timestamp range of the current GoP being processed by #startDecode.
    // This logic is simplified here; #curGoPTimeStamp was not part of the provided code.
    // Let's assume #decodeCursorIndex and ExtMP4Sample.cts can help estimate.
    if (this.#decodeCursorIndex > 0 && this.#decodeCursorIndex < this.samples.length) {
        const currentSampleTime = this.samples[this.#decodeCursorIndex].cts;
        const bufferStartTime = this.#decodedVideoFrames[0]?.timestamp ?? -1;
        const bufferEndTime = this.#decodedVideoFrames.at(-1)?.timestamp ?? -1;

        if (mode === 'accurate') {
            // If time is before the current decoding position (and not covered by buffer)
            if (time < currentSampleTime && (bufferStartTime === -1 || time < bufferStartTime)) return true;
            // If time is significantly after what's buffered and what's being decoded (requires more complex GoP end estimation)
        }
        // Fast mode is more lenient, primarily relies on larger timeDiffs.
    }


    return false;
  }

  private _tryServeFromBuffer(time: number, mode: 'accurate' | 'fast'): VideoFrame | 'continue_parsing' | null {
    if (this.#decodedVideoFrames.length === 0) {
      // Buffer is empty, tell caller to handle state and potentially fill.
      // Before that, ensure filling is triggered if needed.
      this._ensureBufferIsBeingFilled(this.#decoder!, mode);
      return null;
    }

    const firstFrame = this.#decodedVideoFrames[0];

    // Scenario: Seek back or very precise time check for accurate mode
    if (mode === 'accurate' && time < firstFrame.timestamp) {
      // We need an earlier frame than what's buffered.
      // The buffer might need to be cleared and refilled from an earlier point.
      // This specific case might be better handled by _needsDecoderReset in find().
      // For now, if find() didn't reset, and we are here, it implies a problem or requires more complex logic.
      // Let's assume for now that if find() decided not to reset, we don't serve a frame that's too far ahead.
      // Or, this could indicate that #parseFrame should have cleared the buffer after a reset.
      // Returning null signifies no frame served *from buffer* for this specific time.
      return null;
    }

    // Scenario: Frame in buffer is too old for the requested time
    if (firstFrame.timestamp + (firstFrame.duration ?? this.#lastVideoFrameDuration) < time) {
      const oldFrame = this.#decodedVideoFrames.shift()!;
      oldFrame.close();
      this._ensureBufferIsBeingFilled(this.#decoder!, mode);
      return 'continue_parsing'; // Signal to #parseFrame to loop and try again
    }

    // Scenario: Frame in buffer is suitable
    if (mode === 'accurate') {
      // For accurate mode, the frame must encompass the time.
      // The condition `time < firstFrame.timestamp` is handled above.
      // The condition `firstFrame.timestamp + duration < time` is handled above.
      // So, if we reach here, `firstFrame.timestamp <= time <= firstFrame.timestamp + duration`.
      const videoFrame = this.#decodedVideoFrames.shift()!;
      this._ensureBufferIsBeingFilled(this.#decoder!, mode); // Trigger fill if needed
      return videoFrame;
    } else { // mode === 'fast'
      // For fast mode, any frame at or after the requested time is acceptable.
      // The primary check is `firstFrame.timestamp >= time`.
      // However, if the first frame is slightly before but encompasses `time`, it's also good.
      if (firstFrame.timestamp >= time || (time < firstFrame.timestamp + (firstFrame.duration ?? this.#lastVideoFrameDuration))) {
        const videoFrame = this.#decodedVideoFrames.shift()!;
        this._ensureBufferIsBeingFilled(this.#decoder!, mode); // Trigger fill if needed
        return videoFrame;
      }
      // If in fast mode and the frame is too early (timestamp < time and doesn't encompass time),
      // it means we need to discard and continue. This is similar to the "too old" case.
      // This situation should ideally be less common in fast mode if seeking is done properly.
      // Let's treat it as "continue_parsing" to allow the buffer to advance.
      const oldFrame = this.#decodedVideoFrames.shift()!;
      oldFrame.close();
      this._ensureBufferIsBeingFilled(this.#decoder!, mode);
      return 'continue_parsing';
    }
    // Fallback, should ideally not be reached if logic is complete.
    // return null;
  }

  private _ensureBufferIsBeingFilled(decoder: VideoDecoder, mode: 'accurate' | 'fast'): void {
    // Conditions under which we should not try to start a new decode operation:
    // 1. If already actively decoding or buffering with an in-progress operation.
    //    (this.#isDecodingInProgress was removed, using decoder.decodeQueueSize > 0 as a proxy for active work)
    //    Consider re-introducing a more explicit #isDecodingInProgress if needed.
    if ((this.#state === 'Decoding' || this.#state === 'Buffering') && (decoder.decodeQueueSize > 0 || this.#outputFrameCount < this.#inputChunkCount) ) {
      return;
    }
    // 2. If there are no more samples to process.
    if (this.#decodeCursorIndex >= this.samples.length && this.#inputChunkCount >= this.#outputFrameCount) {
      this.#state = 'Idle'; // Or 'EOS' if fully done
      return;
    }
    // 3. If the decoder is not in a configurable state.
    if (decoder.state !== 'configured') {
        // This might happen if an error occurred, or it was closed.
        // #reset should handle re-creating it if necessary.
        return;
    }

    // Determine buffer threshold based on mode.
    const predecodeThreshold = mode === 'fast' ? 1 : VideoFrameFinder.MAX_BUFFER_SIZE_DEFAULT; // MAX_BUFFER_SIZE_DEFAULT is not defined yet, use 5 for now

    if (this.#decodedVideoFrames.length < predecodeThreshold) {
      if (this.#state === 'Idle' || this.#state === 'Seeking' || this.#state === 'Buffering') { // Allow starting decode from Buffering if not already in progress
        this.#startDecode(decoder, mode).catch(err => {
          // Error handling for #startDecode should be robust within #startDecode itself
          // or be caught by the main #parseFrame loop if it bubbles up.
          console.error(this.#logPrefix, "Error during background buffer fill:", err);
          // Potentially set state to Error here if #startDecode doesn't handle it.
          // this.#state = 'Error'; this.#lastError = err;
        });
        // #startDecode will set state to 'Decoding' or 'Buffering'
      }
    }
  }

  // Static constant for buffer size, if needed elsewhere or for clarity
  static readonly MAX_BUFFER_SIZE_DEFAULT = 5;

  private async _handleEmptyBufferAndProcessState(
    time: number, // Current seek time, though less relevant here as state dictates action
    decoder: VideoDecoder,
    aborter: { abort: boolean; startTime: number }, // For timeout
    mode: 'accurate' | 'fast',
  ): Promise<'retry_parse' | null> {
    if (aborter.abort) return null;

    switch (this.#state) {
      case 'Idle':
        // If idle, it means we need to start decoding.
        // _ensureBufferIsBeingFilled should have already been called or will be called by the main loop.
        // If no samples left, it will transition to Idle/EOS correctly.
        this._ensureBufferIsBeingFilled(decoder, mode);
        // If _ensureBufferIsBeingFilled started a decode, state might change to Decoding/Buffering.
        // If no samples left, it might stay Idle or go to EOS.
        if (this.#decodeCursorIndex >= this.samples.length && decoder.decodeQueueSize === 0 && this.#decodedVideoFrames.length === 0) {
            return null; // Truly nothing more to do
        }
        return 'retry_parse';

      case 'Seeking':
        // Seeking implies a reset has happened or is in progress.
        // #reset should transition to Idle or Error. If still Seeking, it implies waiting for configure.
        // If #startDecode was called, it would have set state to Decoding.
        // This state might be short-lived or managed by #reset.
        // For now, assume if we are here, we need to ensure decoding starts or wait.
        this._ensureBufferIsBeingFilled(decoder, mode); // Ensure decoder is kicked off if needed after seek/reset
        // Fall through to 'Buffering' or 'Decoding' style wait if #startDecode was called
        // or simply retry if it's waiting for configuration.
        // The timeout logic below will catch prolonged waits.
        // No break here, fall through to common wait logic if still in progress.

      case 'Buffering': // Implies frames are expected, or decoding is finishing up a GoP
      case 'Decoding':  // Actively decoding a GoP
        // If we are in these states and the buffer is empty (checked by caller),
        // it means we are waiting for the decoder to output frames or finish.
        if (decoder.decodeQueueSize > 0 || (this.#inputChunkCount > this.#outputFrameCount)) { // Check if decoder is working or has pending frames
          if (performance.now() - aborter.startTime > 6000) { // 6-second timeout
            const timeoutDetails = { finderState: this.#getState(), decoderState: decoder.state, queueSize: decoder.decodeQueueSize };
            const timeoutError = new TimeoutError(
              `${this.#logPrefix} Video decoding/buffering timed out after 6s.`,
              timeoutDetails
            );
            console.error(timeoutError.message, timeoutError.finderState);
            this.#state = 'Error';
            this.#lastError = timeoutError;
            throw timeoutError; // Throw, to be caught by the main find/parseFrame
          }
          this.#sleepCount += 1;
          await sleep(15); // Wait a bit for decoder to catch up
          return 'retry_parse';
        } else {
          // Decoder queue is empty, and all input chunks seem to have been outputted.
          // If buffer is also empty, means end of current decoding segment.
          this.#state = 'Idle'; // Transition to Idle, next cycle will decide if more GoPs or EOS.
          if (this.#decodeCursorIndex >= this.samples.length) {
            return null; // End of all samples
          }
          return 'retry_parse'; // Retry to potentially start next GoP or confirm EOS
        }

      case 'EOS': // End Of Samples - All samples sent to decoder
        if (decoder.decodeQueueSize === 0 && this.#decodedVideoFrames.length === 0 && this.#inputChunkCount <= this.#outputFrameCount) {
          // Decoder is idle, buffer is empty, all processed.
          return null;
        }
        // Still waiting for frames to drain from decoder or buffer.
        // Timeout logic similar to Decoding/Buffering
        if (performance.now() - aborter.startTime > 6000) {
          // ... (timeout error handling as above)
          const timeoutDetails = { finderState: this.#getState(), decoderState: decoder.state, queueSize: decoder.decodeQueueSize };
          const timeoutError = new TimeoutError(
            `${this.#logPrefix} Video EOS timeout after 6s.`,
            timeoutDetails
          );
          console.error(timeoutError.message, timeoutError.finderState);
          this.#state = 'Error';
          this.#lastError = timeoutError;
          throw timeoutError;
        }
        await sleep(15);
        return 'retry_parse';

      case 'Error':
        throw this.#lastError ?? new StateError('VideoFrameFinder is in an Error state.');
      case 'Closed':
        return null; // Finder is closed

      default:
        // Should not happen with exhaustive switch
        const unhandledStateError = new StateError(`${this.#logPrefix} Unhandled state in _handleEmptyBufferAndProcessState: ${this.#state}`);
        this.#state = 'Error';
        this.#lastError = unhandledStateError;
        throw unhandledStateError;
    }
  }


  #parseFrame = async (
    time: number,
    decoder: VideoDecoder,
    // aborter is now #currentAborter, managed by find()
    mode: 'accurate' | 'fast',
  ): Promise<VideoFrame | null> => {
    // The aborter for timeout/cancellation is this.#currentAborter, set by find()
    const aborter = this.#currentAborter;

    while (!aborter.abort) {
      if (this.#state === 'Error') {
        throw this.#lastError ?? new StateError(`${this.#logPrefix} VideoFrameFinder is in an Error state during #parseFrame.`);
      }
      if (this.#state === 'Closed') {
        return null;
      }

      const bufferResult = this._tryServeFromBuffer(time, mode);
      if (bufferResult instanceof VideoFrame) {
        return bufferResult;
      }
      if (bufferResult === 'continue_parsing') {
        // Frame was popped, buffer might have changed, loop again.
        // Ensure we don't tight-loop if 'continue_parsing' happens repeatedly without state change.
        // A small sleep or yield might be needed if states don't change appropriately.
        // For now, assume state changes or buffer changes will prevent tight loops.
        await sleep(0); // Yield to event loop
        continue;
      }

      // If bufferResult is null, it means the buffer is empty for the current time,
      // or it's a seek-back scenario not handled by buffer.
      // Now, consult the state machine via _handleEmptyBufferAndProcessState.
      const processResult = await this._handleEmptyBufferAndProcessState(time, decoder, aborter, mode);

      if (processResult === 'retry_parse') {
        // State has been handled (e.g., decoding started, waited), should retry serving from buffer or re-evaluating state.
        await sleep(0); // Yield to event loop before continuing
        continue;
      } else { // processResult is null (e.g., EOS, Closed, or explicit null from handler)
        return null; // Stop parsing
      }
    }
    // Aborted
    return null;
  };

  #startDecode = async (decoder: VideoDecoder, mode: 'accurate' | 'fast') => {
    if (this.#state === 'Decoding' || this.#state === 'Closed' || this.#state === 'Error' || this.#state === 'Seeking') {
      return;
    }

    const maxQueueSize = mode === 'fast' ? 900 : 600;
    if (decoder.state === 'configured' && decoder.decodeQueueSize > maxQueueSize) {
      this.#state = 'Buffering';
      return;
    }

    let endIndex = this.#decodeCursorIndex; // Start endIndex at cursor
    // Find the start of the current GoP if not already in it.
    // This logic might need adjustment if decodeCursorIndex is not always at a GoP start after reset.
    // For now, assume #reset positions it at a keyframe.

    // Scan to find the end of the current GoP (next IDR or end of samples)
    let currentGoPSamples: ExtMP4Sample[] = [];
    let foundNextIDR = false;
    for (let i = this.#decodeCursorIndex; i < this.samples.length; i++) {
        const sample = this.samples[i];
        if (sample.deleted) { // Skip deleted samples
            if (i === this.#decodeCursorIndex) this.#decodeCursorIndex++; // Move cursor if current is deleted
            continue;
        }
        currentGoPSamples.push(sample);
        endIndex = i + 1; // Update endIndex to point after the current sample
        if (sample.is_idr && currentGoPSamples.length > 1) { // Found next IDR, and it's not the first sample in this GoP
            foundNextIDR = true;
            break;
        }
    }

    if (currentGoPSamples.length === 0) {
        this.#state = 'Idle';
        return;
    }
    this.#state = 'Decoding';

    // Ensure first sample is IDR if it's the start of a GoP we are feeding
    if (currentGoPSamples[0].is_idr !== true && this.#inputChunkCount === this.#outputFrameCount) {
         // Only warn if we are expecting to start with a keyframe (i.e., decoder is fresh)
        console.warn(this.#logPrefix, 'First sample of GoP not an IDR frame for decoding.');
    }

    let chunks: EncodedVideoChunk[] = [];
    try {
      chunks = await videoSamplesToEncodedChunks(currentGoPSamples, this.localFileReader);
    } catch (error: any) {
      const sampleReadError = new SampleReadError(
        `${this.#logPrefix} Failed to read video samples: ${error?.message}`,
        { finderState: this.#getState(), cause: error }
      );
      console.error(sampleReadError.message, sampleReadError.finderState);
      this.#state = 'Error';
      this.#lastError = sampleReadError;
      return;
    }

    if (this.#state !== 'Decoding' || decoder.state === 'closed') { return; }

    if (chunks.length > 0) {
        this.#lastVideoFrameDuration = chunks[0]?.duration ?? 0;
        try {
          decodeGoP(decoder, chunks, {}); // Errors handled by decoder.error
        } catch (error: any) {
           const decodingError = new DecodingError(
             `${this.#logPrefix} Synchronous error during decodeGoP: ${error?.message}`,
             { finderState: this.#getState(), cause: error }
           );
           console.error(decodingError.message, decodingError.finderState);
           this.#state = 'Error';
           this.#lastError = decodingError;
           return;
        }
        this.#inputChunkCount += chunks.length;
    } else {
        // No chunks produced, perhaps all samples were deleted in the range
        if (this.#decodeCursorIndex >= this.samples.length) { // If cursor also at end
             this.#state = 'Idle';
        } else if (this.#state === 'Decoding') { // Still decoding but no chunks from this batch
             this.#state = 'Buffering'; // Or Idle, depends on whether output is expected
        }
    }
    this.#decodeCursorIndex = endIndex;
  };

  #reset = async (time?: number) => { // Made async
    this.#state = 'Seeking';
    this.#lastError = null;
    // Abort any pending operations related to the old decoder/state
    this.#currentAborter.abort = true;
    this.#currentAborter = { abort: false, startTime: performance.now() }; // New aborter for this reset/seek

    this.#decodedVideoFrames.forEach((frame) => frame.close());
    this.#decodedVideoFrames = [];

    if (time == null || time === 0) {
      this.#decodeCursorIndex = 0;
    } else {
      let keyFrameIndex = 0;
      for (let i = 0; i < this.samples.length; i++) {
        const sample = this.samples[i];
        if (sample.is_idr) keyFrameIndex = i;
        if (sample.cts >= time) { // Found first sample at or after target time
             if (this.samples[keyFrameIndex].cts > time && keyFrameIndex > 0) {
                 // Find previous keyframe if current keyframe is past the time
                 let prevKeyFrame = 0;
                 for (let j = keyFrameIndex - 1; j >=0; j--) {
                     if (this.samples[j].is_idr) { prevKeyFrame = j; break;}
                 }
                 keyFrameIndex = prevKeyFrame;
             }
             this.#decodeCursorIndex = keyFrameIndex;
             break;
        }
        if (i === this.samples.length - 1) { // Reached end, use last keyframe
            this.#decodeCursorIndex = keyFrameIndex;
        }
      }
    }
    this.#inputChunkCount = 0;
    this.#outputFrameCount = 0;

    if (this.#decoder?.state !== 'closed' && this.#decoder?.state !== 'unconfigured') {
      try {
        // Flush can be useful before close if there are pending frames that should be output or errors generated.
        // However, if we are resetting due to an error or major seek, flushing might not be desired or might hang.
        // For now, directly close. Consider if flush is needed for specific scenarios.
        // await this.#decoder.flush(); // This would make #reset definitively async
      } catch (e) {
        console.warn(`${this.#logPrefix} Error flushing decoder during reset:`, e);
      }
      this.#decoder.close();
    }

    this.#decoder = new VideoDecoder({
      output: (videoFrame) => {
        if (this.#state === 'Closed' || this.#currentAborter.abort) { // Check aborter for this reset cycle
          videoFrame.close();
          return;
        }
        this.#outputFrameCount += 1;
        if (videoFrame.timestamp === -1) { // Should not happen with valid MP4/WebM
          videoFrame.close();
          return;
        }
        let resultVideoFrame = videoFrame;
        if (videoFrame.duration == null || videoFrame.duration === 0) { // Also check for 0 duration
          resultVideoFrame = new VideoFrame(videoFrame, {
            duration: this.#lastVideoFrameDuration > 0 ? this.#lastVideoFrameDuration : 33333, // Default if last is 0
          });
          videoFrame.close();
        }
        this.#decodedVideoFrames.push(resultVideoFrame);
        // If #state was 'Seeking' (set at start of #reset), transition to 'Buffering'
        // as we now have a frame. The main loop will then try to serve or continue.
        if (this.#state === 'Seeking') {
          this.#state = 'Buffering';
        }
      },
      error: (err) => {
        if (this.#state === 'Closed' || this.#currentAborter.abort) return;

        if ((err as Error).message.includes('Codec reclaimed due to inactivity')) {
          // Decoder was reclaimed. Will need to be re-created and re-configured.
          console.warn(this.#logPrefix, (err as Error).message);
          this.#decoder = null; // Mark as null so it's recreated on next find/reset
          this.#state = 'Idle'; // Or Error if this is considered fatal for current operation
          // No automatic #reset here, let the main find loop handle it if another find is called.
          return;
        }

        const currentConfig = this.config;
        if (currentConfig.hardwareAcceleration !== 'prefer-software') {
          console.warn(
            this.#logPrefix,
            `Hardware decode error: ${(err as Error).message}. Attempting software fallback.`,
            currentConfig,
          );
          this.config = { ...this.config, hardwareAcceleration: 'prefer-software' };
          // Calling #reset from within error handler can be tricky.
          // Better to set state to Error and let user/main loop decide to retry, which would trigger reset.
          // For now, to match original intent of auto-fallback:
          this.#reset(this.#currentTimestamp).catch(e => { // #reset is now async
            console.error(`${this.#logPrefix} Error during software fallback reset:`, e);
            this.#state = 'Error';
            this.#lastError = e;
          });
        } else {
          const decodingError = new DecodingError(
            `${this.#logPrefix} VideoFinder VideoDecoder error (software): ${(err as Error).message}`,
            { finderState: this.#getState(), cause: err, config: currentConfig }
          );
          console.error(decodingError.message, decodingError.finderState);
          this.#state = 'Error';
          this.#lastError = decodingError;
        }
      },
    });

    try {
      this.#decoder.configure(this.config);
      // Successfully configured. If we were 'Seeking', transition to 'Idle' to allow #parseFrame to proceed.
      if (this.#state === 'Seeking') {
        this.#state = 'Idle';
      }
    } catch (error: any) { // Catch sync errors from .configure()
      const setupError = new DecoderSetupError(
        `${this.#logPrefix} Failed to configure VideoDecoder: ${error?.message}`,
        { finderState: this.#getState(), cause: error, config: this.config }
      );
      console.error(setupError.message, setupError.finderState);
      this.#state = 'Error';
      this.#lastError = setupError;
    }
  };

  #getState = () => ({
    state: this.#state,
    lastError: this.#lastError?.message,
    time: this.#currentTimestamp,
    decoderConfState: this.#decoder?.state, // Renamed to avoid conflict with VideoFrameFinderState
    decoderQueueSize: this.#decoder?.decodeQueueSize,
    decodeCursorIndex: this.#decodeCursorIndex,
    sampleLength: this.samples.length,
    inputChunkCount: this.#inputChunkCount,
    outputFrameCount: this.#outputFrameCount,
    cachedFrameCount: this.#decodedVideoFrames.length,
    currentVideoDecoderConfig: this.config, // Add current config
    sleepCount: this.#sleepCount,
    memoryInfo: memoryUsageInfo(),
  });

  destroy = () => {
    if (this.#state === 'Closed') return;
    this.#state = 'Closed';
    if (this.#decoder?.state !== 'closed') this.#decoder?.close();
    this.#decoder = null;
    this.#currentAborter.abort = true;
    this.#decodedVideoFrames.forEach((frame) => frame.close());
    this.#decodedVideoFrames = [];
    // this.localFileReader.close(); // localFileReader is passed in, MP4Clip owns it.
  };
}


// Utility functions moved from MP4Clip that are primarily used by VideoFrameFinder or its direct helpers.

/**
 * Converts an array of video MP4Samples into EncodedVideoChunks.
 * Reads sample data from the OPFS file. Optimizes reads for small total sizes.
 */
export async function videoSamplesToEncodedChunks(
  samples: ExtMP4Sample[],
  reader: LocalFileReader,
): Promise<EncodedVideoChunk[]> {
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  if (lastSample == null) return [];

  const rangeSize = lastSample.offset + lastSample.size - firstSample.offset;
  if (rangeSize < 30e6) { // Read all data in one go for small total sizes
    const data = new Uint8Array(
      await reader.read(rangeSize, { at: firstSample.offset }),
    );
    return samples.map((sample) => {
      const offsetInReadData = sample.offset - firstSample.offset;
      return new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: sample.cts,
        duration: sample.duration,
        data: data.subarray(
          offsetInReadData,
          offsetInReadData + sample.size,
        ),
      });
    });
  }

  return await Promise.all(
    samples.map(async (sample) => {
      return new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: sample.cts,
        duration: sample.duration,
        data: await reader.read(sample.size, { at: sample.offset }),
      });
    }),
  );
}

/**
 * Decodes a Group of Pictures (GoP) using the provided VideoDecoder.
 */
export function decodeGoP(
  decoder: VideoDecoder,
  chunks: EncodedVideoChunk[],
  opts: { onDecodingError?: (err: Error) => void }, // Though onDecodingError is now mainly handled by decoder.error
) {
  if (decoder.state !== 'configured') {
    console.warn('decodeGoP called but decoder not configured.');
    return;
  }
  for (let i = 0; i < chunks.length; i++) {
    // Synchronous errors here are less common for .decode(), but possible if parameters are wrong.
    // Asynchronous errors are caught by the decoder's error callback.
    try {
        decoder.decode(chunks[i]);
    } catch (err) {
        if (opts.onDecodingError) opts.onDecodingError(err as Error);
        else throw err; // Rethrow if no specific handler
        return; // Stop decoding this GoP
    }
  }

  decoder.flush().catch((err) => {
    if (!(err instanceof Error)) throw err;
    if (opts.onDecodingError) {
      opts.onDecodingError(err);
      return;
    }
    if (!err.message.includes('Aborted due to close')) {
      // console.error('Error flushing decoder in decodeGoP:', err); // Already handled by decoder.error
    }
  });
}


/**
 * Creates a function that converts VideoFrames to image Blobs using OffscreenCanvas.
 */
export function createVF2BlobConverter(
  width: number,
  height: number,
  opts?: ImageEncodeOptions,
) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to get 2D context from OffscreenCanvas');

  return async (videoFrame: VideoFrame): Promise<Blob> => {
    context.drawImage(videoFrame, 0, 0, width, height);
    videoFrame.close();
    const blob = await canvas.convertToBlob(opts);
    return blob;
  };
}


/**
 * Generates thumbnails from keyframes within a specified time range.
 * This function creates its own temporary decoder.
 */
export async function thumbnailByKeyFrame(
  samples: ExtMP4Sample[], // These should be the full list of video samples for the clip
  localFileReader: LocalFileReader, // Changed from OPFSToolFile to LocalFileReader
  decoderConfig: VideoDecoderConfig, // Base decoder config
  abortSignal: AbortSignal,
  timeRange: { start: number; end: number },
  onOutput: (vf: VideoFrame | null, done: boolean) => void,
  logPrefix: string = 'thumbnailByKeyFrame',
) {
  // Filter for keyframes (sync samples) within the specified time range that are not deleted
  const keyframeSamples = samples.filter(
    (sample) =>
      !sample.deleted &&
      sample.is_sync && // is_idr might be more accurate if NALU parsing was done
      sample.cts >= timeRange.start &&
      sample.cts <= timeRange.end,
  );

  if (keyframeSamples.length === 0) {
    onOutput(null, true);
    return;
  }

  const chunks = await videoSamplesToEncodedChunks(keyframeSamples, localFileReader);

  if (chunks.length === 0 || abortSignal.aborted) {
    onOutput(null, true);
    return;
  }

  let outputCount = 0;
  let tempDecoder: VideoDecoder | null = null;

  function createAndConfigureDecoder(useSoftware: boolean) {
    const currentConfig = {
        ...decoderConfig,
        ...(useSoftware ? { hardwareAcceleration: 'prefer-software' as const } : {})
    };
    tempDecoder = new VideoDecoder({
      output: (vf) => {
        if (abortSignal.aborted) { vf.close(); return; }
        outputCount++;
        onOutput(vf, outputCount === chunks.length);
        if (outputCount === chunks.length) {
          if (tempDecoder?.state !== 'closed') tempDecoder?.close();
        }
      },
      error: (err) => {
        console.error(`${logPrefix} temp decoder error:`, err, currentConfig);
        if (!useSoftware && decoderConfig.hardwareAcceleration !== 'prefer-software') {
          console.info(`${logPrefix} Attempting software fallback for keyframe thumbnails.`);
          if (tempDecoder?.state !== 'closed') tempDecoder?.close();
          createAndConfigureDecoder(true); // Try again with software
          decodeGoP(tempDecoder!, chunks, {
            onDecodingError: (e) => { // This is for flush error
                console.error(`${logPrefix} Software fallback flush error:`, e);
                onOutput(null, true);
            }
          });
        } else {
          onOutput(null, true); // Error even with software or not eligible for fallback
        }
      },
    });
    tempDecoder.configure(currentConfig);
  }

  abortSignal.addEventListener('abort', () => {
    if (tempDecoder?.state !== 'closed') tempDecoder?.close();
    onOutput(null, true);
  }, { once: true });

  try {
    createAndConfigureDecoder(false); // Start with preferred/hardware
    decodeGoP(tempDecoder!, chunks, {
        onDecodingError: (err) => { // This is for flush error mainly
            // The main error handling is in decoder.error for configure/decode
            console.warn(`${logPrefix} Initial decodeGoP flush error:`, err);
            // If outputCount is 0, the decoder.error callback will handle fallback.
            if (outputCount > 0 || abortSignal.aborted) { // If some frames came out or aborted, just signal done.
                onOutput(null, true);
            }
        }
    });
  } catch (err) { // Catch sync errors from configure/decode
    console.error(`${logPrefix} Sync error setting up keyframe thumbnail decoder:`, err);
    onOutput(null, true);
  }
}
