import mp4box, { MP4File, SampleOpts } from '@webav/mp4box.js';
import { EventTool } from './event-tool';
import { createMetaBox } from './meta-box';
import { workerTimer } from './worker-timer';

// Type alias for a cleanup function that takes no arguments and returns void.
type CleanupFunction = () => void;

/**
 * Configuration options for the recodemux function.
 */
interface IRecodemuxOptions {
  /**
   * Video configuration options. If null, video processing will be skipped.
   */
  video: {
    width: number; // Video width in pixels.
    height: number; // Video height in pixels.
    expectFPS: number; // Expected frames per second for the video.
    codec: string; // Video codec string (e.g., 'avc1.42001E').
    bitrate: number; // Target video bitrate in bits per second.
    /**
     * Unsafe option, may be deprecated at any time.
     * Specifies hardware acceleration preference for video encoding.
     */
    __unsafe_hardwareAcceleration__?: HardwareAcceleration;
  } | null;
  /**
   * Audio configuration options. If null, audio processing will be skipped.
   */
  audio: {
    codec: 'opus' | 'aac'; // Audio codec type.
    sampleRate: number; // Audio sample rate in Hz.
    channelCount: number; // Number of audio channels.
  } | null;
  /**
   * Preset duration for the media in microseconds.
   * This does not necessarily represent the actual duration of the tracks
   * but is used for metadata in the MP4 header.
   */
  duration?: number;
  /**
   * Optional metadata tags to be embedded in the MP4 file.
   * The keys are tag names (e.g., "©nam" for title, "©ART" for artist)
   * and values are the corresponding string values.
   */
  metaDataTags?: Record<string, string>;
}

/**
 * @function recodemux
 * @description Handles the encoding of video and audio frames and muxes them into an MP4 container using mp4box.js.
 * It sets up video and audio encoders based on the provided configuration, manages the synchronization
 * of tracks, and provides methods to encode frames, flush encoders, and close the operation.
 *
 * @param {IRecodemuxOptions} options - Configuration options for video and audio encoding, duration, and metadata.
 * @returns {{
 *   encodeVideo: (frame: VideoFrame, options: VideoEncoderEncodeOptions) => void;
 *   encodeAudio: (data: AudioData) => void;
 *   close: CleanupFunction;
 *   flush: () => Promise<void>;
 *   mp4file: MP4File;
 *   getEncodeQueueSize: () => number;
 * }} An object containing:
 *   - `encodeVideo`: Function to encode a single video frame.
 *   - `encodeAudio`: Function to encode a single audio data chunk.
 *   - `close`: Function to close encoders and perform cleanup.
 *   - `flush`: Function to flush any pending data in the encoders.
 *   - `mp4file`: The mp4box.js MP4File instance used for muxing.
 *   - `getEncodeQueueSize`: Function to get the current combined queue size of the encoders, useful for backpressure.
 */
export function recodemux(options: IRecodemuxOptions): {
  encodeVideo: (
    frame: VideoFrame,
    encodeOpts: VideoEncoderEncodeOptions,
    gopId?: number,
  ) => void;
  encodeAudio: (data: AudioData) => void;
  close: CleanupFunction;
  flush: () => Promise<void>;
  mp4file: MP4File;
  getEncodeQueueSize: () => number;
} {
  console.log('[recodemux] options:', options);
  const mp4file = mp4box.createFile(); // Create an mp4box.js MP4File instance.

  // Event tool for synchronizing the readiness of video and audio tracks.
  // The 'moov' box, which contains metadata for all tracks, can only be finalized
  // once both track configurations are known.
  const avSyncEvtTool = new EventTool<
    Record<'VideoReady' | 'AudioReady', () => void>
  >();

  /**
   * Adds metadata tags to the MP4 file within a 'udta' (User Data) -> 'meta' box structure.
   * @param {MP4File['moov']} moov - The 'moov' box of the MP4 file.
   * @param {Record<string, string>} tags - The metadata tags to add.
   */
  const addMetadata = (
    moov: NonNullable<MP4File['moov']>,
    tags: NonNullable<IRecodemuxOptions['metaDataTags']>,
  ) => {
    const udtaBox = moov.add('udta'); // User Data Box
    const metaBox = udtaBox.add('meta'); // Metadata Box (container for iTunes-style metadata)
    metaBox.data = createMetaBox(tags); // Create the actual metadata structure
    metaBox.size = metaBox.data.byteLength;
  };

  let moovIsReady = false; // Flag to ensure onMoovReady logic runs only once.
  /**
   * Callback executed when both audio and video tracks are ready (their configurations are known).
   * This function finalizes the 'moov' box by adding metadata and setting duration.
   */
  const onMoovReady = () => {
    if (mp4file.moov == null || moovIsReady) return;
    moovIsReady = true;

    // Add metadata tags if provided.
    if (options.metaDataTags != null)
      addMetadata(mp4file.moov, options.metaDataTags);
    // Set preset duration in the movie header if provided.
    if (options.duration != null) {
      mp4file.moov.mvhd.duration = options.duration;
    }
  };

  // Register onMoovReady to be called when both tracks signal readiness.
  avSyncEvtTool.once('VideoReady', onMoovReady);
  avSyncEvtTool.once('AudioReady', onMoovReady);

  // Initialize video encoding track if video options are provided.
  const videoEncodeController =
    options.video != null
      ? encodeVideoTrack(options.video, mp4file, avSyncEvtTool)
      : null;
  // Initialize audio encoding track if audio options are provided.
  const audioEncodeController =
    options.audio != null
      ? encodeAudioTrack(options.audio, mp4file, avSyncEvtTool)
      : null;

  // If video or audio is not configured, immediately signal their readiness.
  if (options.video == null) avSyncEvtTool.emit('VideoReady');
  if (options.audio == null) avSyncEvtTool.emit('AudioReady');

  return {
    encodeVideo: (
      videoFrame: VideoFrame,
      encodeOpts: VideoEncoderEncodeOptions,
    ) => {
      videoEncodeController?.encode(videoFrame, encodeOpts);
      videoFrame.close(); // Close the VideoFrame to release its resources.
    },
    encodeAudio: (audioData: AudioData) => {
      if (audioEncodeController == null) return;
      try {
        audioEncodeController.encode(audioData);
        audioData.close(); // Close the AudioData to release its resources.
      } catch (err) {
        const errMsg = `[recodemux encodeAudio] encode audio chunk error: ${
          (err as Error).message
        }, state: ${JSON.stringify({
          queueSize: audioEncodeController.encodeQueueSize,
          state: audioEncodeController.state,
        })}`;
        console.error(errMsg);
        throw Error(errMsg);
      }
    },
    getEncodeQueueSize: () =>
      videoEncodeController?.encodeQueueSize ??
      audioEncodeController?.encodeQueueSize ??
      0,
    flush: async () => {
      await Promise.all([
        videoEncodeController?.flush(),
        audioEncodeController?.state === 'configured'
          ? audioEncodeController.flush()
          : null,
      ]);
    },
    close: () => {
      avSyncEvtTool.destroy();
      videoEncodeController?.close();
      if (audioEncodeController?.state === 'configured')
        audioEncodeController.close();
    },
    mp4file,
  };
}

/**
 * Sets up and manages the video encoding track for an MP4 file.
 * This includes initializing VideoEncoder(s), handling encoded chunks,
 * and adding samples to the mp4box.js file.
 * It employs a dual-encoder strategy to help maintain frame order when
 * encoding can be out-of-order, especially with hardware encoders.
 *
 * @param {NonNullable<IRecodemuxOptions['video']>} videoConfig - Video configuration options.
 * @param {MP4File} mp4File - The mp4box.js MP4File instance.
 * @param {EventTool<Record<'VideoReady' | 'AudioReady', () => void>>} avSyncEvtTool - Event tool for AV sync.
 * @returns An object with methods to encode video frames, flush, close, and get queue size.
 */
function encodeVideoTrack(
  videoConfig: NonNullable<IRecodemuxOptions['video']>,
  mp4File: MP4File,
  avSyncEvtTool: EventTool<Record<'VideoReady' | 'AudioReady', () => void>>,
) {
  const videoTrackOptions = {
    timescale: 1_000_000, // Microseconds, for precise timing.
    width: videoConfig.width,
    height: videoConfig.height,
    brands: ['isom', 'iso2', 'avc1', 'mp42', 'mp41'], // MP4 brands.
    avcDecoderConfigRecord: null as ArrayBuffer | undefined | null, // AVC Coder Configuration Record (avcC box).
    name: 'Track created with WebAV', // Track name metadata.
  };

  let videoTrackId = -1; // Will be set by mp4box.js when the track is added.
  let audioTrackIsReady = false; // Flag to ensure audio track is ready before adding samples if strict ordering is needed.
  avSyncEvtTool.once('AudioReady', () => {
    audioTrackIsReady = true;
  });

  // Cache for samples from the two encoders.
  // This is part of the dual-encoder strategy to reorder frames if necessary.
  const samplesCache: Record<
    'encoder0' | 'encoder1',
    Array<ReturnType<typeof chunkToMP4SampleOptions>>
  > = {
    encoder0: [],
    encoder1: [],
  };

  /**
   * Handles output from a VideoEncoder instance.
   * When the first chunk with metadata arrives, it configures and adds the video track to the MP4 file.
   * Subsequent chunks are cached for ordered addition to the file.
   * @param {'encoder0' | 'encoder1'} encoderId - Identifier for the encoder producing the chunk.
   * @param {EncodedVideoChunk} chunk - The encoded video chunk.
   * @param {EncodedVideoChunkMetadata} [meta] - Metadata for the chunk (e.g., decoder config).
   */
  const outputHandler = (
    encoderId: 'encoder0' | 'encoder1',
    chunk: EncodedVideoChunk,
    meta?: EncodedVideoChunkMetadata,
  ) => {
    // On the first chunk with metadata (decoderConfig), set up the video track.
    if (videoTrackId === -1 && meta?.decoderConfig) {
      const decoderConfigDescription = meta.decoderConfig
        ?.description as ArrayBuffer;
      // Apply a fix for a Chrome bug related to constraint set flags in H.264.
      fixChromeConstraintSetFlagsBug(decoderConfigDescription);
      videoTrackOptions.avcDecoderConfigRecord = decoderConfigDescription;
      videoTrackId = mp4File.addTrack(videoTrackOptions);
      avSyncEvtTool.emit('VideoReady'); // Signal that the video track is configured.
      console.log(
        '[recodemux VideoEncoder] video track ready, trackId:',
        videoTrackId,
      );
    }
    // Convert the chunk to MP4 sample format and add to the respective encoder's cache.
    samplesCache[encoderId].push(chunkToMP4SampleOptions(chunk));
  };

  let currentEncoderId: 'encoder0' | 'encoder1' = 'encoder1'; // Tracks which encoder's cache is currently being prioritized.
  let lastAddedSampleTimestamp = 0; // Timestamp of the last sample added to the file, for ordering.

  // Maximum interval between frames to be considered continuous (part of the same sequence for ordering).
  // Calculated from the expected FPS.
  const maxContinuousFrameInterval = Math.floor(
    (1000 / videoConfig.expectFPS) * 1000,
  ); // in microseconds

  /**
   * Checks the sample caches from both encoders and adds samples to the MP4 file in correct order.
   * This function implements the core logic of the dual-encoder strategy.
   * It prioritizes continuous sequences and ensures keyframes are handled correctly.
   */
  function checkAndAddCachedSamples() {
    if (!audioTrackIsReady) return; // Potentially wait for audio track readiness for strict AV sync if needed.

    const nextEncoderId =
      currentEncoderId === 'encoder1' ? 'encoder0' : 'encoder1';
    const currentEncoderSampleCache = samplesCache[currentEncoderId];
    const nextEncoderSampleCache = samplesCache[nextEncoderId];

    // If both caches are empty, nothing to do.
    if (
      currentEncoderSampleCache.length === 0 &&
      nextEncoderSampleCache.length === 0
    )
      return;

    const currentCacheFirstSample = currentEncoderSampleCache[0];
    // If the current encoder's cache has samples and they form a continuous sequence
    // (not a keyframe or timestamp is close to the last added sample), process this cache.
    if (currentCacheFirstSample != null) {
      if (
        !currentCacheFirstSample.is_sync ||
        currentCacheFirstSample.cts - lastAddedSampleTimestamp <
          maxContinuousFrameInterval
      ) {
        const lastTimestamp = addSamplesFromFileCache(
          currentEncoderSampleCache,
        );
        if (lastTimestamp > lastAddedSampleTimestamp)
          lastAddedSampleTimestamp = lastTimestamp;
      }
    }

    const nextCacheFirstSample = nextEncoderSampleCache[0];
    // If the other encoder's cache has a keyframe that is continuous with the last added sample,
    // switch to processing that cache to maintain order.
    if (
      nextCacheFirstSample?.is_sync &&
      nextCacheFirstSample.cts - lastAddedSampleTimestamp <
        maxContinuousFrameInterval
    ) {
      currentEncoderId = nextEncoderId;
      checkAndAddCachedSamples(); // Re-check immediately with the switched encoder.
      return;
    }

    // If both caches have keyframes and are not continuous with the last added sample,
    // process the one with the earlier timestamp.
    if (currentCacheFirstSample?.is_sync && nextCacheFirstSample?.is_sync) {
      if (currentCacheFirstSample.cts <= nextCacheFirstSample.cts) {
        const lastTimestamp = addSamplesFromFileCache(
          currentEncoderSampleCache,
        );
        if (lastTimestamp > lastAddedSampleTimestamp)
          lastAddedSampleTimestamp = lastTimestamp;
      } else {
        currentEncoderId = nextEncoderId;
        checkAndAddCachedSamples(); // Re-check with the switched encoder.
        return;
      }
    }
  }

  /**
   * Adds samples from a given cache array to the MP4 file until the next keyframe.
   * @param {Array<ReturnType<typeof chunkToMP4SampleOptions>>} sampleQueue - The cache to process.
   * @returns {number} The timestamp of the last sample added, or -1 if no samples were added.
   */
  function addSamplesFromFileCache(
    sampleQueue: Array<ReturnType<typeof chunkToMP4SampleOptions>>,
  ): number {
    let lastTimestamp = -1;
    let samplesProcessedCount = 0;
    for (; samplesProcessedCount < sampleQueue.length; samplesProcessedCount++) {
      const sample = sampleQueue[samplesProcessedCount];
      // Stop if we encounter a keyframe after the first sample (start of a new GoP).
      if (samplesProcessedCount > 0 && sample.is_sync) break;

      mp4File.addSample(videoTrackId, sample.data, sample);
      lastTimestamp = sample.cts + sample.duration;
    }
    // Remove processed samples from the cache.
    sampleQueue.splice(0, samplesProcessedCount);
    return lastTimestamp;
  }

  // Periodically check caches to add samples.
  const timerCleanup = workerTimer(checkAndAddCachedSamples, 15); // Check roughly every 15ms.

  // Create two VideoEncoder instances for the dual-encoder strategy.
  const encoder0 = createVideoEncoder(videoConfig, (chunk, meta) =>
    outputHandler('encoder0', chunk, meta),
  );
  const encoder1 = createVideoEncoder(videoConfig, (chunk, meta) =>
    outputHandler('encoder1', chunk, meta),
  );

  let gopCount = 0; // Counter for Group of Pictures, used to alternate encoders.
  return {
    get encodeQueueSize() {
      return encoder0.encodeQueueSize + encoder1.encodeQueueSize;
    },
    encode: (
      videoFrame: VideoFrame,
      encodeOpts: VideoEncoderEncodeOptions,
    ) => {
      try {
        // Alternate encoders based on keyframes (start of a GoP).
        if (encodeOpts.keyFrame) gopCount += 1;
        const encoder = gopCount % 2 === 0 ? encoder0 : encoder1;
        encoder.encode(videoFrame, encodeOpts);
      } catch (err) {
        const errMsg = `[recodemux VideoEncoder] encode video frame error: ${
          (err as Error).message
        }, state: ${JSON.stringify({
          timestamp: videoFrame.timestamp,
          keyFrame: encodeOpts.keyFrame,
          duration: videoFrame.duration,
          gopCount,
        })}`;
        console.error(errMsg);
        throw Error(errMsg);
      }
    },
    flush: async () => {
      await Promise.all([
        encoder0.state === 'configured' ? encoder0.flush() : null,
        encoder1.state === 'configured' ? encoder1.flush() : null,
      ]);
      timerCleanup(); // Stop the periodic cache check.
      checkAndAddCachedSamples(); // Final check to add any remaining samples.
    },
    close: () => {
      timerCleanup();
      if (encoder0.state === 'configured') encoder0.close();
      if (encoder1.state === 'configured') encoder1.close();
    },
  };
}

/**
 * Fixes a bug in Chrome's H.264 encoder where `constraint_set_flags` in the
 * SPS (Sequence Parameter Set) might be incorrect, leading to decoding issues.
 * This function checks and corrects the specific flags if they seem erroneous.
 * See: https://github.com/WebAV-Tech/WebAV/issues/203
 * @param {ArrayBuffer} description - The decoder configuration description (avcC format).
 */
function fixChromeConstraintSetFlagsBug(description: ArrayBuffer) {
  // The description is typically the avcC box content.
  // constraint_set_flags is usually at a fixed offset within the SPS NAL unit.
  // For avcC, SPS starts after a header. Assuming typical avcC structure:
  // 1 byte version (0x01)
  // 3 bytes profile, compatibility, level (AVCProfileIndication, profile_compatibility, AVCLevelIndication)
  // 1 byte lengthSizeMinusOne and numSPS (6 bits reserved, 2 bits lengthSizeMinusOne, then numSPS)
  // For numSPS=1: 2 bytes SPS length, then SPS data.
  // The constraint_set_flags is the 3rd byte of the SPS NAL unit (after NAL header byte & profile/level).
  // This simplified fix targets a known pattern. A robust solution would parse the SPS.
  const u8 = new Uint8Array(description);
  // Assuming the relevant byte is at index 7 of the avcC description:
  // avcC header (5 bytes) + SPS length (2 bytes) = 7. Then SPS NAL header (1 byte) + profile (1) + compatibility (1)
  // This means constraint_set_flags is often around u8[7+2] or u8[8+2] in raw SPS.
  // The original code targets u8[2] of the *description*, which means it expects `description` to be *just* the SPS NAL unit content.
  // If `description` is avcC, this index is incorrect.
  // Given the original code `u8[2]`, it implies `description` is the SPS content itself, not avcC.
  // Let's assume `description` is the raw SPS data (excluding NAL unit type byte).
  // constraint_set_flags is the 3rd byte in this case (index 2).
  if (u8.length > 2) {
    const constraintSetFlagByte = u8[2];
    // If the last two bits (constraint_set0_flag or constraint_set1_flag) are set,
    // it might indicate an issue with Chrome's encoding of these flags.
    // The original fix suggests these being 1 is problematic.
    if ((constraintSetFlagByte & 0b00000011) !== 0) {
      // If either of the last two bits is 1, clear the byte.
      // This is a heuristic fix.
      console.warn(
        '[recodemux fixChromeConstraintSetFlagsBug] Incorrect constraint_set_flags detected, attempting fix.',
        `Original value: ${constraintSetFlagByte.toString(2)}`,
      );
      u8[2] = 0;
    }
  }
}

/**
 * Creates and configures a VideoEncoder instance.
 * @param {NonNullable<IRecodemuxOptions['video']>} videoOpts - Video configuration options.
 * @param {EncodedVideoChunkOutputCallback} outputHandler - Callback for encoded video chunks.
 * @returns {VideoEncoder} The configured VideoEncoder instance.
 */
function createVideoEncoder(
  videoOpts: NonNullable<IRecodemuxOptions['video']>,
  outputHandler: EncodedVideoChunkOutputCallback,
): VideoEncoder {
  const encoderConfig = {
    codec: videoOpts.codec,
    framerate: videoOpts.expectFPS,
    hardwareAcceleration: videoOpts.__unsafe_hardwareAcceleration__,
    bitrate: videoOpts.bitrate,
    width: videoOpts.width,
    height: videoOpts.height,
    alpha: 'discard' as AlphaOption, // H.264 does not support alpha.
    // avc specific options, necessary for some players/platforms.
    avc: { format: 'avc' as AvcEncoderConfigFormat }, // 'avc' format is widely compatible.
    // 'annexb' format might not be parsed correctly by mp4box.js for mimeCodec.
  } as VideoEncoderConfig; // Cast to VideoEncoderConfig for type safety.

  const encoder = new VideoEncoder({
    error: (err) => {
      const errMsg = `[recodemux VideoEncoder] error: ${
        err.message
      }, config: ${JSON.stringify(encoderConfig)}, state: ${JSON.stringify({
        queueSize: encoder.encodeQueueSize,
        state: encoder.state,
      })}`;
      console.error(errMsg);
      throw Error(errMsg);
    },
    output: outputHandler,
  });

  encoder.configure(encoderConfig);
  return encoder;
}

/**
 * Sets up and manages the audio encoding track for an MP4 file.
 * @param {NonNullable<IRecodemuxOptions['audio']>} audioOpts - Audio configuration options.
 * @param {MP4File} mp4File - The mp4box.js MP4File instance.
 * @param {EventTool<Record<'VideoReady' | 'AudioReady', () => void>>} avSyncEvtTool - Event tool for AV sync.
 * @returns {AudioEncoder} The configured AudioEncoder instance.
 */
function encodeAudioTrack(
  audioOpts: NonNullable<IRecodemuxOptions['audio']>,
  mp4File: MP4File,
  avSyncEvtTool: EventTool<Record<'VideoReady' | 'AudioReady', () => void>>,
): AudioEncoder {
  const audioTrackOptions = {
    timescale: 1_000_000, // Microseconds for precise timing.
    samplerate: audioOpts.sampleRate,
    channel_count: audioOpts.channelCount,
    hdlr: 'soun', // Handler type for sound tracks.
    type: audioOpts.codec === 'aac' ? 'mp4a' : 'Opus', // Track type based on codec.
    name: 'Track created with WebAV',
  };

  let audioTrackId = -1; // Will be set by mp4box.js.
  let sampleCache: EncodedAudioChunk[] = []; // Cache for audio chunks before video track is ready.
  let videoTrackIsReady = false;
  avSyncEvtTool.once('VideoReady', () => {
    videoTrackIsReady = true;
    // Add cached samples once video track is ready (ensures moov is processed correctly).
    sampleCache.forEach((chunk) => {
      const sample = chunkToMP4SampleOptions(chunk);
      mp4File.addSample(audioTrackId, sample.data, sample);
    });
    sampleCache = []; // Clear cache.
  });

  const encoderConfig = {
    codec: audioOpts.codec === 'aac' ? 'mp4a.40.2' : 'opus', // Specific codec string for AAC.
    sampleRate: audioOpts.sampleRate,
    numberOfChannels: audioOpts.channelCount,
    bitrate: 128_000, // Target audio bitrate (e.g., 128 kbps).
  } as AudioEncoderConfig;

  const encoder = new AudioEncoder({
    error: (err) => {
      const errMsg = `[recodemux AudioEncoder] error: ${
        err.message
      }, config: ${JSON.stringify(encoderConfig)}, state: ${JSON.stringify({
        queueSize: encoder.encodeQueueSize,
        state: encoder.state,
      })}`;
      console.error(errMsg);
      throw Error(errMsg);
    },
    output: (chunk, meta) => {
      if (audioTrackId === -1) {
        // On first chunk, add the audio track to mp4box.js.
        // Some devices/browsers might not output description in metadata.
        const decoderConfigDescription = meta?.decoderConfig?.description;
        audioTrackId = mp4File.addTrack({
          ...audioTrackOptions,
          // For AAC, an ESDS (Elementary Stream Descriptor) box is needed in the track description.
          description:
            decoderConfigDescription == null || audioOpts.codec !== 'aac'
              ? undefined
              : createESDSBox(decoderConfigDescription),
        });
        avSyncEvtTool.emit('AudioReady'); // Signal audio track readiness.
        console.log(
          '[recodemux AudioEncoder] audio track ready, trackId:',
          audioTrackId,
        );
      }

      // If video track is ready, add sample directly. Otherwise, cache it.
      if (videoTrackIsReady) {
        const sample = chunkToMP4SampleOptions(chunk);
        mp4File.addSample(audioTrackId, sample.data, sample);
      } else {
        sampleCache.push(chunk);
      }
    },
  });
  encoder.configure(encoderConfig);

  return encoder;
}

/**
 * Creates an ESDS (Elementary Stream Descriptor) box for AAC audio.
 * The ESDS box provides information about the MPEG-4 audio stream, such as codec type,
 * stream type, bitrate, etc. It's required for AAC audio tracks in an MP4 container.
 *
 * @param {ArrayBuffer | ArrayBufferView} configBuffer - The audio-specific configuration (AudioSpecificConfig for AAC).
 * @returns {mp4box.BoxParser.esdsBox} An mp4box.js esdsBox object.
 */
function createESDSBox(
  configBuffer: ArrayBuffer | ArrayBufferView,
): mp4box.BoxParser.esdsBox {
  const configLength = configBuffer.byteLength;
  // Predefined byte structure for an ESDS box containing AAC AudioSpecificConfig.
  // Values are based on ISO/IEC 14496-1 and common practice for AAC.
  const buffer = new Uint8Array([
    0x00, // version = 0
    0x00,
    0x00,
    0x00, // flags = 0

    0x03, // ES_DescrTag
    0x17 + configLength, // size of this descriptor
    0x00, // ES_ID (track_id) (using 0x02 for audio track 2, common for audio)
    0x02, // ES_ID
    0x00, // streamDependenceFlag (0), URL_Flag (0), OCRstreamFlag (0), streamPriority (0)

    0x04, // DecoderConfigDescrTag
    0x0f + configLength, // size of this descriptor (corrected from 0x12, should be 15 + confLen for typical AAC)
    0x40, // objectTypeIndication (0x40 for MPEG-4 Audio)
    0x15, // streamType (0x15 for AudioStream), upstream (0), reserved (1)
    0x00,
    0x00,
    0x00, // bufferSizeDB
    0x00,
    0x00,
    0x00,
    0x00, // maxBitrate
    0x00,
    0x00,
    0x00,
    0x00, // avgBitrate

    0x05, // DecSpecificInfoTag
    configLength, // size of AudioSpecificConfig
    ...new Uint8Array(
      configBuffer instanceof ArrayBuffer
        ? configBuffer
        : configBuffer.buffer,
    ), // AudioSpecificConfig data

    0x06, // SLConfigDescrTag
    0x01, // size of this descriptor
    0x02, // predefined (0x02 indicates specific SL packetization for this stream)
  ]);

  // Use mp4box.js parser to construct the esdsBox object from the buffer.
  // This ensures it's correctly formatted according to mp4box.js internal structures.
  const esdsBox = new mp4box.BoxParser.esdsBox(buffer.byteLength);
  esdsBox.hdr_size = 0; // Header size is part of the buffer already.
  esdsBox.parse(new mp4box.DataStream(buffer, 0, mp4box.DataStream.BIG_ENDIAN));
  return esdsBox;
}

/**
 * Converts an EncodedAudioChunk or EncodedVideoChunk into the options format
 * required by mp4box.js `addSample` method.
 *
 * @param {EncodedAudioChunk | EncodedVideoChunk} chunk - The encoded chunk from WebCodecs API.
 * @returns {SampleOpts & { data: ArrayBuffer }} Options object for mp4box.js `addSample`.
 */
function chunkToMP4SampleOptions(
  chunk: EncodedAudioChunk | EncodedVideoChunk,
): SampleOpts & { data: ArrayBuffer } {
  const buffer = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(buffer); // Copy chunk data into ArrayBuffer.

  const decodeTimestamp = chunk.timestamp; // DTS from the chunk.
  // For MP4, CTS (Composition Time Stamp) can be the same as DTS if there's no B-frame reordering.
  // WebCodecs chunks usually provide presentation timestamps, effectively CTS.
  // mp4box.js expects both DTS and CTS.
  return {
    duration: chunk.duration ?? 0, // Duration of the sample in microseconds.
    dts: decodeTimestamp,
    cts: decodeTimestamp, // Assuming CTS is same as DTS for simplicity here.
    is_sync: chunk.type === 'key', // Mark if it's a keyframe (sync sample).
    data: buffer, // The actual sample data.
  };
}
```
