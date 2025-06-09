import { EventTool, file2stream, recodemux } from '@webav/internal-utils';
import { OffscreenSprite } from './sprite/offscreen-sprite';
import { sleep } from './av-utils';
import { DEFAULT_AUDIO_CONF } from './clips';

export interface ICombinatorOptions {
  width?: number; // Output video width
  height?: number; // Output video height
  bitrate?: number; // Output video bitrate (bits per second)
  fps?: number; // Output video frames per second
  bgColor?: string; // Background color for the canvas
  videoCodec?: string; // Video codec for encoding
  /**
   * If false, the output video file will not include an audio track.
   */
  audio?: false;
  /**
   * Metadata tags to be written into the output video file.
   */
  metaDataTags?: Record<string, string>;
  /**
   * Unsafe option, may be deprecated at any time.
   * Used to specify hardware acceleration preference for video encoding.
   */
  __unsafe_hardwareAcceleration__?: HardwarePreference;
}

/**
 * @class Combinator
 * @description
 * The Combinator class is responsible for orchestrating multiple {@link OffscreenSprite} instances
 * to create a composite video. It manages the rendering of these sprites onto an offscreen canvas
 * according to their individual properties (position, size, timing, z-index, opacity, etc.)
 * and then encodes the combined output into a video stream.
 *
 * It handles:
 * - Adding and managing a list of sprites.
 * - Determining the overall duration of the combined video.
 * - Setting up video and audio encoding using the `recodemux` utility.
 * - Running a rendering loop that, for each frame:
 *   - Clears the canvas.
 *   - Renders all active sprites for the current timestamp.
 *   - Collects audio data from all active sprites.
 *   - Encodes the rendered canvas image as a video frame.
 *   - Encodes the mixed audio data.
 * - Reporting progress of the combination process.
 * - Outputting the final muxed MP4 video as a ReadableStream.
 *
 * @example
 * const sprite1 = new OffscreenSprite(
 *   new MP4Clip((await fetch('<mp4_url>')).body),
 * );
 * const sprite2 = new OffscreenSprite(
 *   new AudioClip((await fetch('<audio_url>')).body),
 * );
 *
 * const combinator = new Combinator({ width: 1280, height: 720 });
 *
 * await combinator.addSprite(sprite1, { main: true }); // `main` helps determine duration
 * await combinator.addSprite(sprite2);
 *
 * const outputStream = combinator.output(); // Returns a ReadableStream of the MP4 file
 * // outputStream can then be used to download the file or process it further.
 *
 * @see [Video Combination Demo](https://webav-tech.github.io/WebAV/demo/2_1-concat-video)
 * @see [Video Dubbing Demo](https://webav-tech.github.io/WebAV/demo/2_2-video-add-audio)
 */
export class Combinator {
  // Static counter for generating unique Combinator instance IDs for logging.
  static #combinatorIdCounter = 0;
  // Instance-specific ID.
  #instanceId = Combinator.#combinatorIdCounter++;
  // Logging prefix for this instance.
  #logPrefix: string;

  #destroyed = false;

  // List of sprites to be combined. Each sprite is augmented with `main` and `expired` flags.
  #sprites: Array<OffscreenSprite & { main: boolean; expired: boolean }> = [];

  #canvas: OffscreenCanvas;
  #context: OffscreenCanvasRenderingContext2D;

  // Function to stop the ongoing output process, if any.
  #stopOutputProcess: (() => void) | null = null;

  #options: Required<ICombinatorOptions>; // Resolved options with defaults.

  #hasVideoTrack: boolean; // Indicates if the output should include a video track.

  #eventTool = new EventTool<{
    OutputProgress: (progressValue: number) => void; // Emits progress (0.0 to 1.0)
    error: (err: Error) => void; // Emits critical errors
  }>();
  on = this.#eventTool.on; // Expose the 'on' method for event subscription.

  /**
   * Checks if the current environment supports the features required by Combinator.
   * This includes OffscreenCanvas, WebCodecs (VideoEncoder, VideoDecoder, AudioEncoder, AudioDecoder, VideoFrame, AudioData),
   * and specific codec configurations.
   * @param {object} [args={}] - Optional arguments to check specific configurations.
   * @param {string} [args.videoCodec='avc1.42E032'] - Video codec to check.
   * @param {number} [args.width=1920] - Video width to check.
   * @param {number} [args.height=1080] - Video height to check.
   * @param {number} [args.bitrate=5e6] - Video bitrate to check.
   * @returns {Promise<boolean>} True if supported, false otherwise.
   */
  static async isSupported(
    args: {
      videoCodec?: string;
      width?: number;
      height?: number;
      bitrate?: number;
    } = {},
  ): Promise<boolean> {
    // Check for presence of essential browser APIs.
    const baseSupported =
      self.OffscreenCanvas != null &&
      self.VideoEncoder != null &&
      self.VideoDecoder != null &&
      self.VideoFrame != null &&
      self.AudioEncoder != null &&
      self.AudioDecoder != null &&
      self.AudioData != null;
    if (!baseSupported) return false;

    // Check if the default or specified video encoder configuration is supported.
    const videoSupported =
      (
        await self.VideoEncoder.isConfigSupported({
          codec: args.videoCodec ?? 'avc1.42E032', // Default H.264 codec
          width: args.width ?? 1920,
          height: args.height ?? 1080,
          bitrate: args.bitrate ?? 7e6, // Default bitrate 7 Mbps
        })
      ).supported ?? false;

    // Check if the default audio encoder configuration (AAC) is supported.
    const audioSupported =
      (
        await self.AudioEncoder.isConfigSupported({
          codec: DEFAULT_AUDIO_CONF.codec, // e.g., 'mp4a.40.2'
          sampleRate: DEFAULT_AUDIO_CONF.sampleRate,
          numberOfChannels: DEFAULT_AUDIO_CONF.channelCount,
        })
      ).supported ?? false;

    return videoSupported && audioSupported;
  }

  /**
   * Creates an instance of Combinator.
   * @param {ICombinatorOptions} [options={}] - Configuration options for the Combinator.
   * @throws {Error} If an OffscreenCanvas 2D context cannot be created.
   */
  constructor(options: ICombinatorOptions = {}) {
    this.#logPrefix = `Combinator id:${this.#instanceId}:`;
    const { width = 0, height = 0 } = options;
    this.#canvas = new OffscreenCanvas(width, height);
    const context = this.#canvas.getContext('2d', { alpha: false });
    if (context == null)
      throw Error(`${this.#logPrefix} Cannot create 2D offscreen context`);
    this.#context = context;

    // Merge provided options with defaults.
    this.#options = Object.assign(
      {
        bgColor: '#000', // Default background color: black
        width: 0,
        height: 0,
        videoCodec: 'avc1.42E032', // Default video codec
        audio: true, // Default to include audio
        bitrate: 5e6, // Default bitrate 5 Mbps
        fps: 30, // Default FPS 30
        metaDataTags: {}, // Default no metadata tags
        __unsafe_hardwareAcceleration__: undefined,
      },
      options,
    );

    // Determine if a video track is needed based on dimensions.
    this.#hasVideoTrack = this.#options.width * this.#options.height > 0;
    console.log(this.#logPrefix, 'Combinator initialized with options:', this.#options);
  }

  /**
   * Adds an {@link OffscreenSprite} to the combination.
   * Sprites are rendered in ascending order of their `zIndex`.
   * The overall video duration is typically determined by the `main` sprite or the maximum
   * end time of all sprites.
   * @param {OffscreenSprite} offscreenSprite - The sprite to add.
   * @param {object} [options={}] - Options for adding the sprite.
   * @param {boolean} [options.main=false] - If true, this sprite's duration significantly influences
   *                                       the total output duration.
   * @returns {Promise<void>}
   */
  async addSprite(
    offscreenSprite: OffscreenSprite,
    options: { main?: boolean } = {},
  ): Promise<void> {
    // Log relevant attributes of the sprite being added.
    const logAttrs = {
      rect: pick(['x', 'y', 'w', 'h'], offscreenSprite.rect),
      time: { ...offscreenSprite.time },
      zIndex: offscreenSprite.zIndex,
    };
    console.log(this.#logPrefix, 'addSprite - input sprite:', logAttrs);

    // Clone the sprite to ensure the Combinator works with an isolated instance.
    const newClonedSprite = await offscreenSprite.clone();
    console.log(this.#logPrefix, 'addSprite - cloned sprite ready.');

    // Add the cloned sprite to the internal list, augmenting it with `main` and `expired` flags.
    this.#sprites.push(
      Object.assign(newClonedSprite, {
        main: options.main ?? false, // Mark as main sprite if specified.
        expired: false, // `expired` flag tracks if sprite has finished its duration.
      }),
    );
    // Sort sprites by zIndex to ensure correct rendering order.
    this.#sprites.sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * Initializes the `recodemux` operation with the configured video and audio settings.
   * @param {number} duration - The total duration of the output video in microseconds.
   * @returns {ReturnType<typeof recodemux>} The `recodemux` instance.
   */
  #startRecodemuxOperation(duration: number) {
    const {
      fps,
      width,
      height,
      videoCodec,
      bitrate,
      audio: audioEnabled, // Renamed from `audio` to avoid conflict
      metaDataTags,
    } = this.#options;

    // Configure `recodemux` based on whether a video track is needed and audio is enabled.
    const recodeOperation = recodemux({
      video: this.#hasVideoTrack
        ? {
            width,
            height,
            expectFPS: fps,
            codec: videoCodec,
            bitrate,
            __unsafe_hardwareAcceleration__:
              this.#options.__unsafe_hardwareAcceleration__,
          }
        : null, // No video if width or height is 0.
      audio:
        audioEnabled === false
          ? null // No audio if explicitly disabled.
          : {
              codec: 'aac', // Default to AAC audio.
              sampleRate: DEFAULT_AUDIO_CONF.sampleRate,
              channelCount: DEFAULT_AUDIO_CONF.channelCount,
            },
      duration, // Overall duration for MP4 metadata.
      metaDataTags: metaDataTags,
    });
    return recodeOperation;
  }

  /**
   * Starts the video combination process and returns a ReadableStream of the output MP4 file.
   * @returns {ReadableStream<Uint8Array>} A stream of Uint8Array chunks representing the MP4 file.
   * @throws {Error} If no sprites have been added or if the duration cannot be determined.
   */
  output(): ReadableStream<Uint8Array> {
    if (this.#sprites.length === 0)
      throw Error(`${this.#logPrefix} No sprite added.`);

    // Determine the main sprite, which dictates the primary duration.
    const mainSprite = this.#sprites.find((it) => it.main);
    // Calculate maximum time: prioritize main sprite's end time, otherwise use max end time of all sprites.
    const maxTimeMicros =
      mainSprite != null
        ? mainSprite.time.offset + mainSprite.time.duration
        : Math.max(
            ...this.#sprites.map(
              (it) => it.time.offset + it.time.duration,
            ),
          );

    // If maxTime is Infinity, it means some sprites have unbounded duration (e.g., static image with no duration).
    if (maxTimeMicros === Infinity) {
      throw Error(
        `${this.#logPrefix} Unable to determine the end time, please specify a main sprite, or limit the duration of ImgClip, AudioClip.`,
      );
    }
    // A maxTime of -1 (or less than 0) might indicate an issue, e.g. main sprite has 0 duration.
    if (maxTimeMicros < 0) {
      console.warn(
        this.#logPrefix,
        "Unable to determine a valid end time (maxTime < 0). Progress reporting might be affected. Output will proceed based on sprite states.",
      );
    }

    console.log(this.#logPrefix, `Start combination, calculated maxTime: ${maxTimeMicros}μs`);
    // Initialize the recodemux operation.
    const recodeMuxOperation = this.#startRecodemuxOperation(maxTimeMicros);
    const MuxStartTime = performance.now();

    // Start the core encoding loop.
    const stopEncodeLoop = this.#executeEncodeLoop(
      recodeMuxOperation,
      maxTimeMicros,
      {
        onProgress: (progressValue) => {
          console.debug(this.#logPrefix, 'OutputProgress:', progressValue);
          this.#eventTool.emit('OutputProgress', progressValue);
        },
        onEnded: async () => {
          await recodeMuxOperation.flush(); // Ensure all buffered frames are processed.
          console.log(
            this.#logPrefix,
            `===== output ended =====, cost: ${
              performance.now() - MuxStartTime
            }ms`,
          );
          this.#eventTool.emit('OutputProgress', 1); // Signal 100% progress.
          this.destroy(); // Clean up Combinator resources.
        },
        onError: (err) => {
          this.#eventTool.emit('error', err);
          closeOutputStream(err); // Close the output stream with an error.
          this.destroy();
        },
      },
    );

    // Set up the function to stop the output process if needed externally or on destroy.
    this.#stopOutputProcess = () => {
      stopEncodeLoop();
      recodeMuxOperation.close();
      closeOutputStream(); // Close output stream without error if stopped cleanly.
    };

    // Convert the mp4box.js file object into a ReadableStream.
    const { stream, stop: closeOutputStream } = file2stream(
      recodeMuxOperation.mp4file,
      500, // Interval for checking new data from mp4file.
      () => this.destroy(), // Callback if the stream is cancelled by the consumer.
    );

    return stream;
  }

  /**
   * Destroys the Combinator instance, releasing all resources.
   * This includes stopping any ongoing output process and cleaning up event listeners.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    console.log(this.#logPrefix, 'Destroying Combinator.');

    this.#stopOutputProcess?.(); // Stop any ongoing encoding.
    this.#eventTool.destroy(); // Clean up event listeners.
    // Sprites are destroyed within the run loop or by #stopOutputProcess.
  }

  /**
   * The core rendering and encoding loop.
   * It iterates through time, renders sprites, encodes frames, and manages progress.
   * @param recodeMuxOperation - The recodemux instance for encoding.
   * @param maxTimeMicros - The maximum duration of the output in microseconds.
   * @param callbacks - Callbacks for progress, completion, and errors.
   * @returns A function to stop this encoding loop.
   */
  #executeEncodeLoop(
    recodeMuxOperation: ReturnType<typeof recodemux>,
    maxTimeMicros: number,
    {
      onProgress,
      onEnded,
      onError,
    }: {
      onProgress: (progressValue: number) => void;
      onEnded: () => Promise<void>;
      onError: (err: Error) => void;
    },
  ): () => void {
    let currentProgress = 0;
    const abortController = { aborted: false }; // Simple abort flag.
    let loopError: Error | null = null;

    const runAsync = async () => {
      const { fps, bgColor, audio: outputAudioEnabled } = this.#options;
      // Interval between frames in microseconds.
      const frameIntervalMicros = Math.round(1e6 / fps);

      const context = this.#context;
      // Create a sprite renderer function.
      const spriteRenderer = createSpritesRender({
        context,
        bgColor,
        sprites: this.#sprites,
        abortSignal: abortController, // Pass abort flag.
      });
      // Create an AV encoder function.
      const avEncoder = createAVEncoder({
        recodeMuxOperation,
        context,
        canvas: this.#canvas,
        outputAudioEnabled: outputAudioEnabled !== false,
        hasVideoTrack: this.#hasVideoTrack,
        frameDurationMicros: frameIntervalMicros,
        fps,
      });

      let currentTimeMicros = 0;
      while (true) {
        if (loopError != null) return; // Exit if an error occurred in a previous iteration.
        // Check for abort, or if maxTime reached, or if no sprites left.
        if (
          abortController.aborted ||
          (maxTimeMicros < 0 ? false : currentTimeMicros > maxTimeMicros) || // Handle indeterminate maxTime
          this.#sprites.length === 0
        ) {
          await finalizeLoop();
          return;
        }
        // Update progress (avoid division by zero or negative maxTime).
        currentProgress = maxTimeMicros > 0 ? currentTimeMicros / maxTimeMicros : 0;

        // Render all active sprites for the current timestamp.
        const {
          audioDataChunks,
          isMainSpriteDone,
        } = await spriteRenderer(currentTimeMicros);

        // If the main sprite is done, end the combination.
        if (isMainSpriteDone) {
          await finalizeLoop();
          return;
        }

        if (abortController.aborted) return; // Check abort again after async operation.

        // Encode the rendered frame and collected audio.
        avEncoder(currentTimeMicros, audioDataChunks);

        currentTimeMicros += frameIntervalMicros; // Advance time.

        // Pause if encoder queue is getting too large to prevent memory issues.
        await letEncoderCalmDown(recodeMuxOperation.getEncodeQueueSize);
      }
    };

    runAsync().catch((e) => {
      loopError = e;
      console.error(this.#logPrefix, 'Error in encoding loop:', e);
      stopLoop(); // Ensure loop cleanup logic is called.
      onError(e);
    });

    // Periodically report progress.
    const progressReportingIntervalId = setInterval(() => {
      onProgress(currentProgress);
    }, 500);

    const finalizeLoop = async () => {
      if (abortController.aborted && !loopError) { // If aborted cleanly, don't call onEnded if there was an error already.
         console.log(this.#logPrefix, 'Encoding loop aborted, not calling onEnded.');
      } else if (!loopError) { // Only call onEnded if no error occurred during the loop itself
        await onEnded();
      }
      stopLoop(); // Common cleanup.
    };

    // Function to stop the loop and clear resources.
    const stopLoop = () => {
      if (abortController.aborted && !loopError) { // Check if already stopped to avoid redundant cleanup
        // If loopError is set, it means cleanup might have been initiated by the catch block.
        // If aborted is true but no loopError, it means external stop or natural completion.
        return;
      }
      abortController.aborted = true;
      clearInterval(progressReportingIntervalId);
      // Destroy all sprites when the loop stops.
      this.#sprites.forEach((s) => s.destroy());
      this.#sprites = []; // Clear the sprite list.
      console.log(this.#logPrefix, 'Encoding loop stopped.');
    };

    return stopLoop;
  }
}

/**
 * Creates a function that renders all active sprites onto a canvas for a given timestamp.
 * @param opts Options for sprite rendering.
 * @param opts.context The 2D rendering context of the OffscreenCanvas.
 * @param opts.bgColor Background color for the canvas.
 * @param opts.sprites Array of OffscreenSprites to render.
 * @param opts.abortSignal An object with an `aborted` flag to signal interruption.
 * @returns An async function that takes a timestamp and renders sprites, returning their audio and completion status.
 */
function createSpritesRender(opts: {
  context: OffscreenCanvasRenderingContext2D;
  bgColor: string;
  sprites: Array<OffscreenSprite & { main: boolean; expired: boolean }>;
  abortSignal: { aborted: boolean };
}) {
  const { context, bgColor, sprites, abortSignal } = opts;
  const { width, height } = context.canvas;

  return async (
    currentTimeMicros: number,
  ): Promise<{ audioDataChunks: Float32Array[][]; isMainSpriteDone: boolean }> => {
    // Clear canvas with background color.
    context.fillStyle = bgColor;
    context.fillRect(0, 0, width, height);

    const collectedAudioChunks: Float32Array[][] = [];
    let isMainSpriteDone = false;

    for (const sprite of sprites) {
      if (abortSignal.aborted) break; // Stop if aborted.
      // Skip sprite if current time is before its offset or if it has already expired.
      if (currentTimeMicros < sprite.time.offset || sprite.expired) continue;

      context.save(); // Save context state before rendering each sprite.
      const { audio: spriteAudio, done: spriteIsDone } =
        await sprite.offscreenRender(
          context,
          currentTimeMicros - sprite.time.offset, // Pass time relative to sprite's own timeline.
        );
      collectedAudioChunks.push(spriteAudio);
      context.restore(); // Restore context state.

      // Mark sprite as expired if its duration is exceeded or if it signals it's done.
      if (
        (sprite.time.duration > 0 &&
          currentTimeMicros >= sprite.time.offset + sprite.time.duration) ||
        spriteIsDone
      ) {
        if (sprite.main) isMainSpriteDone = true; // If the main sprite is done, signal to stop.

        sprite.destroy(); // Destroy the sprite to release its resources.
        sprite.expired = true; // Mark as expired.
      }
    }
    // Filter out expired sprites from the main list.
    // This is not done here to avoid modifying the array while iterating.
    // The loop itself will skip expired sprites in subsequent iterations.
    // Consider moving this to the main loop (#executeEncodeLoop) if modification is desired.

    return {
      audioDataChunks: collectedAudioChunks,
      isMainSpriteDone,
    };
  };
}

/**
 * Creates a function that encodes the rendered canvas (as a video frame)
 * and collected audio data using the provided `recodemux` instance.
 * @param opts Options for the AV encoder.
 * @param opts.recodeMuxOperation The `recodemux` instance.
 * @param opts.context The 2D rendering context (used for clearing).
 * @param opts.canvas The OffscreenCanvas (source for VideoFrame).
 * @param opts.outputAudioEnabled Whether to encode audio.
 * @param opts.hasVideoTrack Whether to encode video.
 * @param opts.frameDurationMicros Duration of each video frame.
 * @param opts.fps Frames per second (used for keyframe interval).
 * @returns A function that takes a timestamp and audio data chunks, and encodes them.
 */
function createAVEncoder(opts: {
  recodeMuxOperation: ReturnType<typeof recodemux>;
  context: OffscreenCanvasRenderingContext2D;
  canvas: OffscreenCanvas;
  outputAudioEnabled: boolean;
  hasVideoTrack: boolean;
  frameDurationMicros: number;
  fps: number;
}) {
  const {
    recodeMuxOperation,
    context,
    canvas,
    outputAudioEnabled,
    hasVideoTrack,
    frameDurationMicros,
  } = opts;
  const { width, height } = canvas;
  let frameCounter = 0;
  // Keyframe interval: e.g., every 3 seconds.
  const keyframeIntervalFrames = Math.floor(3 * opts.fps);

  // Create an audio buffer to manage and chunk audio data.
  const audioTrackBuffer = createAudioTrackBuffer(1024); // Buffer size of 1024 PCM frames per AudioData.

  return (
    currentTimeMicros: number,
    audioDataChunks: Float32Array[][],
  ) => {
    if (outputAudioEnabled) {
      // Process and encode audio data.
      for (const audioData of audioTrackBuffer(
        currentTimeMicros,
        audioDataChunks,
      )) {
        recodeMuxOperation.encodeAudio(audioData);
      }
    }

    if (hasVideoTrack) {
      // Create a VideoFrame from the canvas content.
      const videoFrame = new VideoFrame(canvas, {
        duration: frameDurationMicros,
        timestamp: currentTimeMicros,
      });

      // Encode the video frame, marking keyframes at intervals.
      recodeMuxOperation.encodeVideo(videoFrame, {
        keyFrame: frameCounter % keyframeIntervalFrames === 0,
      });
      // Reset canvas transform and clear for the next frame (though clearing is usually done by spriteRenderer).
      // This is more of a safeguard if spriteRenderer doesn't fully clear.
      context.resetTransform();
      context.clearRect(0, 0, width, height);

      frameCounter += 1;
    }
  };
}

/**
 * Creates a buffer for audio data from multiple tracks. It mixes the audio tracks
 * and chunks the mixed audio into AudioData objects of a fixed frame count.
 * This helps provide consistently sized AudioData to the encoder.
 *
 * @param {number} audioDataPcmFrameCount - The number of PCM frames each output AudioData should contain.
 * @returns A function that accepts a timestamp and an array of audio track PCM data,
 *          and returns an array of AudioData objects.
 */
export function createAudioTrackBuffer(audioDataPcmFrameCount: number) {
  // Total number of PCM samples per AudioData object (frames * channels).
  const pcmSamplesPerAudioData =
    audioDataPcmFrameCount * DEFAULT_AUDIO_CONF.channelCount;
  // Internal buffer to store mixed PCM data. Sized for 3x AudioData objects to handle overflow.
  const pcmChannelBuffer = new Float32Array(pcmSamplesPerAudioData * 3);
  let pcmBufferWriteOffset = 0; // Current writing position in pcmChannelBuffer.

  let currentAudioTimestampMicros = 0; // Timestamp for the next AudioData to be created.
  // Duration of one AudioData object in microseconds.
  const audioDataDurationMicros =
    (audioDataPcmFrameCount / DEFAULT_AUDIO_CONF.sampleRate) * 1e6;

  // Placeholder (silent) data for when input audio is insufficient to fill an AudioData object.
  const silentPlaceholderAudioData = new Float32Array(pcmSamplesPerAudioData);

  /**
   * Consumes data from pcmChannelBuffer and creates AudioData objects.
   * Also generates silent AudioData if there's a gap between current time and buffered audio.
   * @param {number} targetTimestampMicros - The current timestamp of the media being processed.
   * @returns {AudioData[]} An array of AudioData objects.
   */
  const generateAudioDataFromBuffer = (
    targetTimestampMicros: number,
  ): AudioData[] => {
    let bufferReadOffset = 0;
    // Number of full AudioData objects that can be created from the current buffer.
    const audioDataObjectsCount = Math.floor(
      pcmBufferWriteOffset / pcmSamplesPerAudioData,
    );
    const outputAudioData: AudioData[] = [];

    // Create AudioData from buffered PCM samples.
    for (let i = 0; i < audioDataObjectsCount; i++) {
      outputAudioData.push(
        new AudioData({
          timestamp: currentAudioTimestampMicros,
          numberOfChannels: DEFAULT_AUDIO_CONF.channelCount,
          numberOfFrames: audioDataPcmFrameCount,
          sampleRate: DEFAULT_AUDIO_CONF.sampleRate,
          format: 'f32', // PCM float32 format.
          data: pcmChannelBuffer.subarray(
            bufferReadOffset,
            bufferReadOffset + pcmSamplesPerAudioData,
          ),
        }),
      );
      bufferReadOffset += pcmSamplesPerAudioData;
      currentAudioTimestampMicros += audioDataDurationMicros;
    }
    // Shift remaining PCM data in the buffer to the beginning.
    pcmChannelBuffer.set(
      pcmChannelBuffer.subarray(bufferReadOffset, pcmBufferWriteOffset),
      0,
    );
    pcmBufferWriteOffset -= bufferReadOffset;

    // If there's a time gap, fill with silent AudioData.
    while (
      targetTimestampMicros - currentAudioTimestampMicros >
      audioDataDurationMicros
    ) {
      outputAudioData.push(
        new AudioData({
          timestamp: currentAudioTimestampMicros,
          numberOfChannels: DEFAULT_AUDIO_CONF.channelCount,
          numberOfFrames: audioDataPcmFrameCount,
          sampleRate: DEFAULT_AUDIO_CONF.sampleRate,
          format: 'f32',
          data: silentPlaceholderAudioData,
        }),
      );
      currentAudioTimestampMicros += audioDataDurationMicros;
    }
    return outputAudioData;
  };

  /**
   * Accepts PCM data from multiple audio tracks for a given timestamp, mixes them,
   * buffers the result, and generates AudioData objects.
   * @param {number} currentTimeMicros - The current media timestamp.
   * @param {Float32Array[][]} inputAudioTracksPcm - An array where each element is an audio track,
   *                                                and each track is an array of Float32Arrays (one per channel).
   * @returns {AudioData[]} An array of AudioData objects ready for encoding.
   */
  return (
    currentTimeMicros: number,
    inputAudioTracksPcm: Float32Array[][],
  ): AudioData[] => {
    // Determine the maximum length (number of PCM samples) among all input tracks for this iteration.
    const maxInputLength = Math.max(
      ...inputAudioTracksPcm.map((track) => track[0]?.length ?? 0),
    );

    // Mix samples from all tracks frame by frame.
    for (let sampleIndex = 0; sampleIndex < maxInputLength; sampleIndex++) {
      let mixedChannel0Sample = 0;
      let mixedChannel1Sample = 0; // Assuming stereo output.
      for (
        let trackIndex = 0;
        trackIndex < inputAudioTracksPcm.length;
        trackIndex++
      ) {
        const channel0Sample =
          inputAudioTracksPcm[trackIndex][0]?.[sampleIndex] ?? 0;
        // If input is mono, duplicate channel 0 to channel 1.
        const channel1Sample =
          inputAudioTracksPcm[trackIndex][1]?.[sampleIndex] ??
          channel0Sample;
        mixedChannel0Sample += channel0Sample;
        mixedChannel1Sample += channel1Sample;
      }
      // Add mixed samples to the buffer.
      // Assumes DEFAULT_AUDIO_CONF.channelCount is 2.
      pcmChannelBuffer[pcmBufferWriteOffset] = mixedChannel0Sample;
      pcmChannelBuffer[pcmBufferWriteOffset + 1] = mixedChannel1Sample;
      pcmBufferWriteOffset += DEFAULT_AUDIO_CONF.channelCount;
    }
    // Generate AudioData objects from the buffered and mixed PCM data.
    return generateAudioDataFromBuffer(currentTimeMicros);
  };
}

/**
 * Utility function to pick specified keys from an object.
 * @template K, T
 * @param {K[]} keys - Array of keys to pick.
 * @param {T} obj - The object to pick from.
 * @returns {Pick<T, K>} A new object containing only the picked key-value pairs.
 */
function pick<K extends keyof T, T extends object>(
  keys: K[],
  obj: T,
): Pick<T, K> {
  return keys.reduce(
    (acc, key) => {
      acc[key] = obj[key];
      return acc;
    },
    {} as Pick<T, K>,
  );
}

/**
 * Pauses execution if the encoder's queue size is too large,
 * allowing the encoder to "calm down" and process its backlog.
 * This helps prevent excessive memory usage, especially with hardware encoders.
 * @param {() => number} getQueueSize - Function that returns the current encoder queue size.
 * @returns {Promise<void>}
 */
async function letEncoderCalmDown(getQueueSize: () => number): Promise<void> {
  // If queue size exceeds a threshold (e.g., 50 frames), wait and re-check.
  if (getQueueSize() > 50) {
    await sleep(15); // Wait for a short period (e.g., 15ms).
    await letEncoderCalmDown(getQueueSize); // Recursive call to continue checking.
  }
}
```
