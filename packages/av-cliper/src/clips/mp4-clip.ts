import { MP4Info, MP4Sample } from '@webav/mp4box.js';
import { audioResample, extractPCM4AudioData, sleep } from '../av-utils';
import {
  extractFileConfig,
  quickParseMP4File,
} from '../mp4-utils/mp4box-utils';
import { DEFAULT_AUDIO_CONF, IClip } from './iclip';
import { file, tmpfile, write } from 'opfs-tools';

let CLIP_ID = 0;

// Type alias for the file object returned by opfs-tools' file() function
type OPFSToolFile = ReturnType<typeof file>;
// Type guard to check if an object is an OPFSToolFile
function isOPFSToolFile(obj: any): obj is OPFSToolFile {
  return obj.kind === 'file' && obj.createReader instanceof Function;
}

// Type for arguments used when creating an MP4Clip instance internally (e.g., for cloning)
type MPClipCloneArgs = Awaited<ReturnType<typeof mp4FileToSamples>> & {
  localFile: OPFSToolFile; // The local file representation in OPFS
};

// Interface for MP4 decoder configurations
interface MP4DecoderConfig {
  video: VideoDecoderConfig | null; // Video decoder configuration
  audio: AudioDecoderConfig | null; // Audio decoder configuration
}

// Options for configuring an MP4Clip instance
interface MP4ClipOpts {
  audio?: boolean | { volume: number }; // Audio processing options (enable/disable or set volume)
  /**
   * Unsafe option, may be deprecated at any time.
   * Used to specify hardware acceleration preference for video decoding.
   */
  __unsafe_hardwareAcceleration__?: HardwarePreference;
}

// Extended MP4Sample type, omitting the original 'data' and adding specific properties
type ExtMP4Sample = Omit<MP4Sample, 'data'> & {
  is_idr: boolean; // Indicates if the sample is an Instantaneous Decoder Refresh (IDR) frame
  deleted?: boolean; // Flag to mark a sample as deleted (e.g., after splitting)
  data: null | Uint8Array; // Raw sample data (null for video to be loaded on demand, Uint8Array for audio)
};

// Type alias for the file reader created from an OPFSToolFile
type LocalFileReader = Awaited<ReturnType<OPFSToolFile['createReader']>>;

// Options for thumbnail generation
type ThumbnailOpts = {
  start: number; // Start time for thumbnail generation (microseconds)
  end: number; // End time for thumbnail generation (microseconds)
  step: number; // Interval between thumbnails (microseconds)
};

/**
 * Represents an MP4 clip. It parses an MP4 file and allows on-demand decoding
 * of image frames and audio data at specified times using the {@link MP4Clip.tick} method.
 *
 * This class can be used for functionalities like video frame extraction,
 * thumbnail generation, and video editing.
 *
 * @example
 * // From a fetch response body
 * new MP4Clip((await fetch('<mp4_url>')).body)
 * // From an OPFS file stream
 * new MP4Clip(mp4File.stream())
 *
 * @see {@link Combinator} - For combining multiple clips.
 * @see [AVCanvas](../../av-canvas/classes/AVCanvas.html) - For rendering clips on a canvas.
 * @see [Decode and Play Video (Demo)](https://webav-tech.github.io/WebAV/demo/1_1-decode-video)
 */
export class MP4Clip implements IClip {
  // Unique instance ID for the clip
  #insId = CLIP_ID++;

  // Prefix for console logging, includes instance ID for easier debugging
  #logPrefix: string;

  // Promise that resolves when the clip is ready (metadata parsed, decoders initialized)
  ready: IClip['ready'];

  // Flag indicating if the clip has been destroyed
  #destroyed = false;

  // Metadata of the MP4 clip
  #meta = {
    duration: 0, // Duration in microseconds
    width: 0, // Video width in pixels
    height: 0, // Video height in pixels
    audioSampleRate: 0, // Audio sample rate in Hz
    audioChanCount: 0, // Number of audio channels
  };

  // Getter for a copy of the metadata to prevent external modification
  get meta() {
    return { ...this.#meta };
  }

  // Local file representation in OPFS (Origin Private File System)
  #localFile: OPFSToolFile;

  // Array storing the start position and size of header boxes (ftyp, moov) in the MP4 file
  #headerBoxPos: Array<{ start: number; size: number }> = [];

  /**
   * Provides the binary data of the video header (ftyp and moov boxes).
   * This data can be parsed by any MP4 demuxer to get detailed video information.
   * Unit tests include an example of parsing this data using mp4box.js.
   * @returns A Promise that resolves with an ArrayBuffer containing the header data.
   * @throws Error if the localFile is not an origin file (cannot be sliced).
   */
  async getFileHeaderBinData() {
    await this.ready; // Ensure the clip is ready
    const originFile = await this.#localFile.getOriginFile(); // Get the underlying File object
    if (originFile == null)
      throw Error('MP4Clip localFile is not an origin file');

    // Slice the header box data from the original file and combine into a single ArrayBuffer
    return await new Blob(
      this.#headerBoxPos.map(({ start, size }) =>
        originFile.slice(start, start + size),
      ),
    ).arrayBuffer();
  }

  // Audio volume level (0.0 to 1.0)
  #volume = 1;

  // Array of extended video samples
  #videoSamples: ExtMP4Sample[] = [];

  // Array of extended audio samples
  #audioSamples: ExtMP4Sample[] = [];

  // Finder instance for efficiently locating and decoding video frames
  #videoFrameFinder: VideoFrameFinder | null = null;
  // Finder instance for efficiently locating and decoding audio frames
  #audioFrameFinder: AudioFrameFinder | null = null;

  // Decoder configurations for video and audio
  #decoderConfig: {
    video: VideoDecoderConfig | null;
    audio: AudioDecoderConfig | null;
  } = {
    video: null,
    audio: null,
  };

  // Options passed to the constructor
  #opts: MP4ClipOpts = { audio: true };

  constructor(
    source: OPFSToolFile | ReadableStream<Uint8Array> | MPClipCloneArgs,
    opts: MP4ClipOpts = {},
  ) {
    this.#logPrefix = `MP4Clip id:${this.#insId}:`;
    // Validate the source argument
    if (
      !(source instanceof ReadableStream) &&
      !isOPFSToolFile(source) &&
      // Check if it's not the internal clone arguments type
      !('videoSamples' in source && Array.isArray(source.videoSamples))
    ) {
      throw Error(
        `${this.#logPrefix} Illegal argument for MP4Clip constructor`,
      );
    }

    this.#opts = { audio: true, ...opts }; // Merge default options with provided ones
    // Set volume based on options
    this.#volume =
      typeof opts.audio === 'object' && 'volume' in opts.audio
        ? opts.audio.volume
        : 1;

    // Asynchronously initializes the clip by writing the stream to a local file
    const initByStream = async (stream: ReadableStream) => {
      await write(this.#localFile, stream); // Write stream data to the OPFS file
      return this.#localFile;
    };

    // Determine the local file source
    this.#localFile = isOPFSToolFile(source)
      ? source // If source is already an OPFSToolFile
      : 'localFile' in source
        ? source.localFile // If source is from clone arguments
        : tmpfile(); // Otherwise, create a temporary file

    // The ready promise resolves when the MP4 metadata is parsed and decoders are set up
    this.ready = (
      source instanceof ReadableStream
        ? initByStream(source).then((opfsToolsFile) =>
            mp4FileToSamples(opfsToolsFile, this.#opts, this.#logPrefix),
          ) // If source is a stream, initialize and then parse
        : isOPFSToolFile(source)
          ? mp4FileToSamples(source, this.#opts, this.#logPrefix) // If source is an OPFS file, parse directly
          : Promise.resolve(source as MPClipCloneArgs) // If source is clone arguments, it's already processed
    ).then(
      async ({
        videoSamples,
        audioSamples,
        decoderConf: rawDecoderConfig,
        headerBoxPos,
      }) => {
        this.#videoSamples = videoSamples;
        this.#audioSamples = audioSamples;
        this.#decoderConfig = rawDecoderConfig;
        this.#headerBoxPos = headerBoxPos;

        // Generate decoder instances (VideoFrameFinder, AudioFrameFinder)
        const { videoFrameFinder, audioFrameFinder } = genDecoder(
          {
            video:
              rawDecoderConfig.video == null
                ? null
                : {
                    ...rawDecoderConfig.video,
                    // Apply hardware acceleration preference from options
                    hardwareAcceleration:
                      this.#opts.__unsafe_hardwareAcceleration__,
                  },
            audio: rawDecoderConfig.audio,
          },
          await this.#localFile.createReader(), // Create a reader for the local file
          videoSamples,
          audioSamples,
          this.#opts.audio !== false ? this.#volume : 0, // Set volume (0 if audio is disabled)
          this.#logPrefix,
        );
        this.#videoFrameFinder = videoFrameFinder;
        this.#audioFrameFinder = audioFrameFinder;

        // Generate and store metadata
        this.#meta = genMeta(
          rawDecoderConfig,
          videoSamples,
          audioSamples,
        );
        console.log(this.#logPrefix, 'MP4Clip meta:', this.#meta);
        return { ...this.#meta }; // Resolve ready promise with metadata
      },
    );
  }

  /**
   * Intercepts the data returned by the {@link MP4Clip.tick} method,
   * allowing for secondary processing of image and audio data.
   * @param time - The time passed to the tick method (microseconds).
   * @param tickRet - The data returned by the tick method.
   * @returns A Promise that resolves to the (potentially modified) tick data.
   *
   * @see [Remove Green Screen Background from Video (Demo)](https://webav-tech.github.io/WebAV/demo/3_2-chromakey-video)
   */
  tickInterceptor: <T extends Awaited<ReturnType<MP4Clip['tick']>>>(
    time: number,
    tickRet: T,
  ) => Promise<T> = async (_, tickRet) => tickRet; // Default interceptor returns data unmodified

  /**
   * Retrieves the video frame and audio data for a specific time in the clip.
   * @param time - The time in microseconds for which to retrieve data.
   * @returns A Promise that resolves to an object containing:
   *   - `video?`: A {@link VideoFrame} if available at the given time.
   *   - `audio`: An array of `Float32Array`s, each representing a channel of audio data.
   *   - `state`: 'success' if data is retrieved, or 'done' if the time is at or beyond the clip's duration.
   */
  async tick(time: number): Promise<{
    video?: VideoFrame;
    audio: Float32Array[];
    state: 'success' | 'done';
  }> {
    // If requested time is beyond the duration, return 'done' state
    if (time >= this.#meta.duration) {
      return await this.tickInterceptor(time, {
        audio: (await this.#audioFrameFinder?.find(time)) ?? [], // Still try to get trailing audio
        state: 'done',
      });
    }

    // Concurrently find audio and video frames for the given time
    const [audio, video] = await Promise.all([
      this.#audioFrameFinder?.find(time) ?? [], // Default to empty array if no audio finder
      this.#videoFrameFinder?.find(time),
    ]);

    // If no video frame is found, return audio only
    if (video == null) {
      return await this.tickInterceptor(time, {
        audio,
        state: 'success',
      });
    }

    // Return both video and audio
    return await this.tickInterceptor(time, {
      video,
      audio,
      state: 'success',
    });
  }

  // AbortController for cancelling ongoing thumbnail generation
  #thumbAborter = new AbortController();
  /**
   * Generates thumbnails for the video clip.
   * By default, it generates one thumbnail (100px wide) for each keyframe.
   *
   * @param imgWidth - The width of the generated thumbnails in pixels (default: 100).
   * @param opts - Optional parameters to customize thumbnail generation (start, end, step).
   * @returns A Promise that resolves to an array of objects, each containing a timestamp (`ts`) and an image Blob (`img`).
   * @throws Error if thumbnail generation is aborted.
   */
  async thumbnails(
    imgWidth = 100,
    opts?: Partial<ThumbnailOpts>,
  ): Promise<Array<{ ts: number; img: Blob }>> {
    this.#thumbAborter.abort(); // Abort any previous thumbnail generation
    this.#thumbAborter = new AbortController(); // Create a new AbortController
    const aborterSignal = this.#thumbAborter.signal; // Get the signal for the new controller

    await this.ready; // Ensure the clip is ready
    const abortMsg = 'generate thumbnails aborted';
    if (aborterSignal.aborted) throw Error(abortMsg); // Check if aborted before starting

    const { width, height } = this.#meta;
    // Create a converter function to turn VideoFrames into image Blobs
    const vfToBlobConverter = createVF2BlobConverter(
      imgWidth,
      Math.round(height * (imgWidth / width)), // Calculate proportional height
      { quality: 0.1, type: 'image/png' }, // Image encoding options
    );

    return new Promise<Array<{ ts: number; img: Blob }>>(
      async (resolve, reject) => {
        let pngPromises: Array<{ ts: number; img: Promise<Blob> }> = [];
        const videoConfig = this.#decoderConfig.video;
        if (videoConfig == null || this.#videoSamples.length === 0) {
          // If no video track or samples, resolve with empty array
          resolvePNGs();
          return;
        }
        // Listen for abort signal
        aborterSignal.addEventListener('abort', () => {
          reject(Error(abortMsg));
        });

        // Function to resolve the main promise with all generated thumbnails
        async function resolvePNGs() {
          if (aborterSignal.aborted) return; // Don't resolve if aborted
          resolve(
            await Promise.all(
              pngPromises.map(async (it) => ({
                ts: it.ts,
                img: await it.img, // Wait for each Blob to be generated
              })),
            ),
          );
        }

        // Helper to add a VideoFrame-to-Blob conversion promise to the list
        function addPNGPromise(videoFrame: VideoFrame) {
          pngPromises.push({
            ts: videoFrame.timestamp,
            img: vfToBlobConverter(videoFrame),
          });
        }

        const {
          start = 0,
          end = this.#meta.duration,
          step,
        } = opts ?? {}; // Default options if not provided

        if (step) {
          // If a step is provided, generate thumbnails at fixed intervals
          let currentTime = start;
          // Create a new VideoFrameFinder instance to avoid conflicts with the main tick method
          const videoFrameFinder = new VideoFrameFinder(
            await this.#localFile.createReader(),
            this.#videoSamples,
            {
              ...videoConfig,
              hardwareAcceleration: this.#opts.__unsafe_hardwareAcceleration__,
            },
            this.#logPrefix,
          );
          while (currentTime <= end && !aborterSignal.aborted) {
            const videoFrame = await videoFrameFinder.find(currentTime);
            if (videoFrame) addPNGPromise(videoFrame);
            currentTime += step;
          }
          videoFrameFinder.destroy(); // Clean up the temporary finder
          resolvePNGs();
        } else {
          // If no step, generate thumbnails from keyframes
          await thumbnailByKeyFrame(
            this.#videoSamples,
            this.#localFile,
            videoConfig,
            aborterSignal,
            { start, end },
            (videoFrame, done) => {
              if (videoFrame != null) addPNGPromise(videoFrame);
              if (done) resolvePNGs();
            },
            this.#logPrefix,
          );
        }
      },
    );
  }

  /**
   * Splits the MP4Clip into two new MP4Clip instances at the specified time.
   * @param time - The time in microseconds at which to split the clip.
   * @returns A Promise that resolves to an array containing two new MP4Clip instances.
   * @throws Error if the time is out of bounds (less than or equal to 0, or greater than or equal to duration).
   */
  async split(time: number): Promise<[this, this]> {
    await this.ready; // Ensure the clip is ready

    if (time <= 0 || time >= this.#meta.duration)
      throw Error('"time" out of bounds');

    // Split video and audio samples based on the given time
    const [preVideoSlice, postVideoSlice] = splitVideoSampleByTime(
      this.#videoSamples,
      time,
    );
    const [preAudioSlice, postAudioSlice] = splitAudioSampleByTime(
      this.#audioSamples,
      time,
    );

    // Create the first clip (before the split time)
    const preClip = new MP4Clip(
      {
        localFile: this.#localFile, // Share the same local file
        videoSamples: preVideoSlice ?? [],
        audioSamples: preAudioSlice ?? [],
        decoderConf: this.#decoderConfig, // Share decoder configuration
        headerBoxPos: this.#headerBoxPos, // Share header box positions
      },
      this.#opts, // Share original options
    );
    // Create the second clip (after the split time)
    const postClip = new MP4Clip(
      {
        localFile: this.#localFile,
        videoSamples: postVideoSlice ?? [],
        audioSamples: postAudioSlice ?? [],
        decoderConf: this.#decoderConfig,
        headerBoxPos: this.#headerBoxPos,
      },
      this.#opts,
    );

    // Wait for both new clips to be ready
    await Promise.all([preClip.ready, postClip.ready]);

    return [preClip, postClip] as [this, this];
  }

  /**
   * Creates a new MP4Clip instance that is a shallow copy of the current clip.
   * Sample data and configurations are copied, but the underlying local file is shared.
   * @returns A Promise that resolves to the cloned MP4Clip instance.
   */
  async clone(): Promise<this> {
    await this.ready; // Ensure the current clip is ready
    const clip = new MP4Clip(
      {
        localFile: this.#localFile, // Share local file
        videoSamples: [...this.#videoSamples], // Shallow copy of video samples
        audioSamples: [...this.#audioSamples], // Shallow copy of audio samples
        decoderConf: this.#decoderConfig, // Copy decoder config
        headerBoxPos: this.#headerBoxPos, // Copy header box positions
      },
      this.#opts, // Copy options
    );
    await clip.ready; // Wait for the cloned clip to be ready
    clip.tickInterceptor = this.tickInterceptor; // Copy the tick interceptor
    return clip as this;
  }

  /**
   * Splits the MP4Clip into separate clips, one containing only the video track
   * and another containing only the audio track, if they exist.
   * @returns A Promise that resolves to an array of MP4Clip instances (either one or two, depending on available tracks).
   */
  async splitTrack(): Promise<MP4Clip[]> {
    await this.ready; // Ensure the clip is ready
    const clips: MP4Clip[] = [];

    // If there are video samples, create a video-only clip
    if (this.#videoSamples.length > 0) {
      const videoClip = new MP4Clip(
        {
          localFile: this.#localFile,
          videoSamples: [...this.#videoSamples],
          audioSamples: [], // No audio samples for video-only clip
          decoderConf: {
            video: this.#decoderConfig.video, // Use original video config
            audio: null, // No audio config
          },
          headerBoxPos: this.#headerBoxPos,
        },
        this.#opts,
      );
      await videoClip.ready;
      videoClip.tickInterceptor = this.tickInterceptor; // Copy interceptor
      clips.push(videoClip);
    }

    // If there are audio samples, create an audio-only clip
    if (this.#audioSamples.length > 0) {
      const audioClip = new MP4Clip(
        {
          localFile: this.#localFile,
          videoSamples: [], // No video samples for audio-only clip
          audioSamples: [...this.#audioSamples],
          decoderConf: {
            audio: this.#decoderConfig.audio, // Use original audio config
            video: null, // No video config
          },
          headerBoxPos: this.#headerBoxPos,
        },
        this.#opts,
      );
      await audioClip.ready;
      audioClip.tickInterceptor = this.tickInterceptor; // Copy interceptor
      clips.push(audioClip);
    }

    return clips;
  }

  /**
   * Destroys the clip, releasing resources such as decoders and file readers.
   * Marks the clip as destroyed to prevent further operations.
   */
  destroy(): void {
    if (this.#destroyed) return; // Prevent multiple destructions
    console.log(this.#logPrefix, 'MP4Clip destroy');
    this.#destroyed = true;

    // Destroy video and audio frame finders
    this.#videoFrameFinder?.destroy();
    this.#audioFrameFinder?.destroy();
  }
}

/**
 * Generates metadata for the MP4 clip based on decoder configurations and sample data.
 * @param decoderConfig - Video and audio decoder configurations.
 * @param videoSamples - Array of extended video samples.
 * @param audioSamples - Array of extended audio samples.
 * @returns An object containing metadata (duration, width, height, audioSampleRate, audioChanCount).
 */
function genMeta(
  decoderConfig: MP4DecoderConfig,
  videoSamples: ExtMP4Sample[],
  audioSamples: ExtMP4Sample[],
) {
  const meta = {
    duration: 0,
    width: 0,
    height: 0,
    audioSampleRate: 0,
    audioChanCount: 0,
  };

  // Populate video metadata if video track exists
  if (decoderConfig.video != null && videoSamples.length > 0) {
    meta.width = decoderConfig.video.codedWidth ?? 0;
    meta.height = decoderConfig.video.codedHeight ?? 0;
  }
  // Populate audio metadata if audio track exists
  if (decoderConfig.audio != null && audioSamples.length > 0) {
    meta.audioSampleRate = DEFAULT_AUDIO_CONF.sampleRate; // Use default if not available in config (should be)
    meta.audioChanCount = DEFAULT_AUDIO_CONF.channelCount; // Use default if not available in config
  }

  let videoDuration = 0;
  let audioDuration = 0;
  // Calculate duration from video samples (timestamp of last sample + its duration)
  if (videoSamples.length > 0) {
    for (let i = videoSamples.length - 1; i >= 0; i--) {
      const sample = videoSamples[i];
      if (sample.deleted) continue; // Skip deleted samples
      videoDuration = sample.cts + sample.duration;
      break;
    }
  }
  // Calculate duration from audio samples
  if (audioSamples.length > 0) {
    const lastSample = audioSamples.at(-1)!; // Non-null assertion as length > 0
    audioDuration = lastSample.cts + lastSample.duration;
  }
  // Overall duration is the maximum of video and audio durations
  meta.duration = Math.max(videoDuration, audioDuration);

  return meta;
}

/**
 * Creates and initializes VideoFrameFinder and AudioFrameFinder instances.
 * @param decoderConfig - Video and audio decoder configurations.
 * @param localFileReader - Reader for the local OPFS file.
 * @param videoSamples - Array of extended video samples.
 * @param audioSamples - Array of extended audio samples.
 * @param volume - Audio volume level.
 * @param logPrefix - Prefix for console logging.
 * @returns An object containing the initialized VideoFrameFinder and AudioFrameFinder (or null if not applicable).
 */
function genDecoder(
  decoderConfig: MP4DecoderConfig,
  localFileReader: LocalFileReader,
  videoSamples: ExtMP4Sample[],
  audioSamples: ExtMP4Sample[],
  volume: number,
  logPrefix: string,
) {
  return {
    // Initialize AudioFrameFinder if audio is enabled, config exists, and samples are present
    audioFrameFinder:
      volume === 0 ||
      decoderConfig.audio == null ||
      audioSamples.length === 0
        ? null
        : new AudioFrameFinder(
            localFileReader,
            audioSamples,
            decoderConfig.audio,
            {
              volume,
              targetSampleRate: DEFAULT_AUDIO_CONF.sampleRate,
            },
            logPrefix,
          ),
    // Initialize VideoFrameFinder if video config exists and samples are present
    videoFrameFinder:
      decoderConfig.video == null || videoSamples.length === 0
        ? null
        : new VideoFrameFinder(
            localFileReader,
            videoSamples,
            decoderConfig.video,
            logPrefix,
          ),
  };
}

/**
 * Parses an MP4 file (from OPFSToolFile) to extract samples, decoder configurations, and header box positions.
 * @param opfsToolsFile - The OPFS file object.
 * @param opts - MP4Clip options.
 * @param logPrefix - Prefix for console logging.
 * @returns A Promise that resolves with an object containing videoSamples, audioSamples, decoderConf, and headerBoxPos.
 * @throws Error if the stream parsing completes but no metadata (mp4Info) is emitted, or if no samples are found.
 */
async function mp4FileToSamples(
  opfsToolsFile: OPFSToolFile,
  opts: MP4ClipOpts = {},
  logPrefix: string,
) {
  let mp4Info: MP4Info | null = null; // To store MP4 metadata from mp4box.js
  const decoderConfig: MP4DecoderConfig = { video: null, audio: null }; // To store decoder configurations
  let videoSamples: ExtMP4Sample[] = []; // To store extracted video samples
  let audioSamples: ExtMP4Sample[] = []; // To store extracted audio samples
  let headerBoxPos: Array<{ start: number; size: number }> = []; // To store positions of ftyp and moov boxes

  let videoDeltaTS = -1; // Timestamp offset for video samples (to make first sample's DTS near zero)
  let audioDeltaTS = -1; // Timestamp offset for audio samples
  const reader = await opfsToolsFile.createReader(); // Create a reader for the OPFS file

  // Use quickParseMP4File to efficiently parse the MP4 file
  await quickParseMP4File(
    reader,
    // onReady callback: called when mp4box.js has parsed the 'moov' atom
    (data) => {
      mp4Info = data.info; // Store the MP4 info
      const ftypBox = data.mp4boxFile.ftyp!; // Get ftyp box (non-null assertion)
      headerBoxPos.push({ start: ftypBox.start, size: ftypBox.size }); // Store its position and size
      const moovBox = data.mp4boxFile.moov!; // Get moov box
      headerBoxPos.push({ start: moovBox.start, size: moovBox.size }); // Store its position and size

      // Extract video and audio decoder configurations from the parsed file
      let {
        videoDecoderConf: rawVideoConfig,
        audioDecoderConf: rawAudioConfig,
      } = extractFileConfig(data.mp4boxFile, data.info);
      decoderConfig.video = rawVideoConfig ?? null;
      decoderConfig.audio = rawAudioConfig ?? null;

      if (rawVideoConfig == null && rawAudioConfig == null) {
        console.error(logPrefix, 'MP4Clip no video and audio track');
      }
      console.info(
        logPrefix,
        'mp4BoxFile moov ready',
        {
          // Log relevant info, excluding bulky track details for brevity
          ...data.info,
          tracks: null,
          videoTracks: null,
          audioTracks: null,
        },
        decoderConfig,
      );
    },
    // onSamples callback: called when mp4box.js has extracted sample metadata
    (_, type, samples) => {
      if (type === 'video') {
        if (videoDeltaTS === -1) videoDeltaTS = samples[0].dts; // Set delta based on first video sample's DTS
        for (const sample of samples) {
          // Normalize timescale and store extended sample info
          videoSamples.push(
            normalizeTimescale(sample, videoDeltaTS, 'video', logPrefix),
          );
        }
      } else if (type === 'audio' && opts.audio) {
        // Process audio samples only if audio is enabled in options
        if (audioDeltaTS === -1) audioDeltaTS = samples[0].dts; // Set delta for audio
        for (const sample of samples) {
          audioSamples.push(
            normalizeTimescale(sample, audioDeltaTS, 'audio', logPrefix),
          );
        }
      }
    },
  );
  await reader.close(); // Close the file reader

  const lastSample = videoSamples.at(-1) ?? audioSamples.at(-1);
  if (mp4Info == null) {
    throw Error(`${logPrefix} MP4Clip stream is done, but not emit ready`);
  } else if (lastSample == null) {
    throw Error(`${logPrefix} MP4Clip stream not contain any sample`);
  }
  // Attempt to fix potential black frame issue at the beginning of the video
  fixFirstBlackFrame(videoSamples, logPrefix);
  console.info(logPrefix, 'mp4 stream parsed');
  return {
    videoSamples,
    audioSamples,
    decoderConf: decoderConfig,
    headerBoxPos,
  };

  /**
   * Normalizes sample timestamps (CTS, DTS, duration) to microseconds (1e6 timescale)
   * and adjusts them by a delta to make the first sample's DTS close to zero.
   * Also identifies IDR frames and handles potential NALU offsets for AVC/HEVC.
   */
  function normalizeTimescale(
    sample: MP4Sample,
    delta = 0,
    sampleType: 'video' | 'audio',
    logPrefix: string,
  ): ExtMP4Sample {
    // Determine if it's an IDR frame and find NALU offset if applicable (for video)
    const idrNALUInfo =
      sampleType === 'video' && sample.is_sync
        ? findIDRNALUOffset(sample.data, sample.description.type)
        : { offset: -1 };
    let dataOffset = sample.offset;
    let dataSize = sample.size;
    // If IDR NALU offset is found, adjust data offset and size to skip preceding NALUs (e.g., SEI)
    // This can prevent decoding issues with some decoders.
    if (idrNALUInfo.offset >= 0) {
      dataOffset += idrNALUInfo.offset;
      dataSize -= idrNALUInfo.offset;
    }
    return {
      ...sample,
      is_idr: idrNALUInfo.offset >= 0, // Mark if it's an IDR frame (or contains one after offset)
      offset: dataOffset,
      size: dataSize,
      // Normalize timestamps to microseconds (timescale 1e6)
      cts: ((sample.cts - delta) / sample.timescale) * 1e6,
      dts: ((sample.dts - delta) / sample.timescale) * 1e6,
      duration: (sample.duration / sample.timescale) * 1e6,
      timescale: 1e6, // Set timescale to microseconds
      // For audio, data is kept in memory. For video, it's set to null to be loaded on demand.
      data: sampleType === 'video' ? null : sample.data,
    };
  }
}

/**
 * Manages video frame decoding and retrieval.
 * It efficiently seeks to the requested time, decodes a Group of Pictures (GoP),
 * and provides the target VideoFrame.
 */
class VideoFrameFinder {
  #decoder: VideoDecoder | null = null; // The VideoDecoder instance
  #logPrefix: string; // Prefix for console logging

  constructor(
    public localFileReader: LocalFileReader, // Reader for the OPFS file
    public samples: ExtMP4Sample[], // Array of extended video samples
    public config: VideoDecoderConfig, // Video decoder configuration
    logPrefix: string,
  ) {
    this.#logPrefix = `${logPrefix} VideoFrameFinder:`;
  }

  #currentTimestamp = 0; // Timestamp of the last requested frame (microseconds)
  #currentAborter = { abort: false, startTime: performance.now() }; // Aborter for ongoing find operation

  /**
   * Finds and returns a VideoFrame for the specified time.
   * @param time - The target time in microseconds.
   * @returns A Promise that resolves to a VideoFrame or null if not found or aborted.
   */
  find = async (time: number): Promise<VideoFrame | null> => {
    // Reset decoder if:
    // - It's null or closed
    // - Seeking backwards in time (time <= this.#currentTimestamp)
    // - Seeking too far forward (more than 3 seconds, indicating a significant jump)
    if (
      this.#decoder == null ||
      this.#decoder.state === 'closed' ||
      time <= this.#currentTimestamp ||
      time - this.#currentTimestamp > 3e6 // 3 seconds
    ) {
      this.#reset(time); // Reset decoder and seek to the new time
    }

    this.#currentAborter.abort = true; // Abort any previous find operation
    this.#currentTimestamp = time; // Update current timestamp

    // Start new find operation
    this.#currentAborter = { abort: false, startTime: performance.now() };
    const videoFrame = await this.#parseFrame(
      time,
      this.#decoder,
      this.#currentAborter,
    );
    this.#sleepCount = 0; // Reset sleep counter after successful find
    return videoFrame;
  };

  #lastVideoFrameDuration = 0; // Stores the duration of the last decoded VideoFrame, used if a frame lacks duration

  #useSoftwareDecoding = false; // Flag to indicate if software decoding is being used (after hardware failure)
  #decodeCursorIndex = 0; // Current index in the samples array for decoding
  #decodedVideoFrames: VideoFrame[] = []; // Buffer for decoded video frames
  #outputFrameCount = 0; // Counter for frames output by the decoder
  #inputChunkCount = 0; // Counter for chunks sent to the decoder
  #sleepCount = 0; // Counter for how many times parsing has slept waiting for frames
  #predecodeError = false; // Flag if an error occurred during pre-decoding

  /**
   * Internal method to parse frames until the target time is reached.
   * Manages decoding, frame buffering, and error handling.
   * @param time - Target time in microseconds.
   * @param decoder - The VideoDecoder instance.
   * @param aborter - Abort controller for the current find operation.
   * @returns A Promise resolving to a VideoFrame or null.
   * @throws Error if decoding times out.
   */
  #parseFrame = async (
    time: number,
    decoder: VideoDecoder | null,
    aborter: { abort: boolean; startTime: number },
  ): Promise<VideoFrame | null> => {
    // If decoder is invalid or operation is aborted, return null
    if (decoder == null || decoder.state === 'closed' || aborter.abort)
      return null;

    // Check buffered frames first
    if (this.#decodedVideoFrames.length > 0) {
      const videoFrame = this.#decodedVideoFrames[0];
      // If the target time is before the first buffered frame, it means we overshot or seeked back
      if (time < videoFrame.timestamp) return null;

      this.#decodedVideoFrames.shift(); // Remove the first frame from buffer
      // If the frame is too old (target time is past its duration), close it and try again
      if (time > videoFrame.timestamp + (videoFrame.duration ?? 0)) {
        videoFrame.close();
        return await this.#parseFrame(time, decoder, aborter); // Recursively call to get next frame
      }

      // If buffer is running low and no predecode error, start pre-decoding next GoP
      if (!this.#predecodeError && this.#decodedVideoFrames.length < 10) {
        this.#startDecode(decoder).catch((err) => {
          this.#predecodeError = true; // Mark predecode error
          this.#reset(time); // Reset decoder on error
          throw err;
        });
      }
      // Frame is suitable, return it
      return videoFrame;
    }

    // If no suitable frame in buffer, check decoder state
    if (
      this.#isDecodingInProgress || // If currently decoding
      // Or if there are pending frames in decoder queue
      (this.#outputFrameCount < this.#inputChunkCount &&
        decoder.decodeQueueSize > 0)
    ) {
      // Timeout check: if parsing takes too long, throw an error
      if (performance.now() - aborter.startTime > 6000) {
        // 6 seconds timeout
        throw Error(
          `${this.#logPrefix} MP4Clip.tick video timeout, ${JSON.stringify(
            this.#getState(),
          )}`,
        );
      }
      // Decoder is busy, wait and retry
      this.#sleepCount += 1;
      await sleep(15); // Sleep for a short duration
    } else if (this.#decodeCursorIndex >= this.samples.length) {
      // All samples processed, no more frames
      return null;
    } else {
      // Need more frames, start decoding the next GoP
      try {
        await this.#startDecode(decoder);
      } catch (err) {
        this.#reset(time); // Reset decoder on error
        throw err;
      }
    }
    // Recursively call to continue parsing
    return await this.#parseFrame(time, decoder, aborter);
  };

  #isDecodingInProgress = false; // Flag indicating if a decode operation is active

  /**
   * Starts decoding the next Group of Pictures (GoP) from the sample list.
   * @param decoder - The VideoDecoder instance.
   */
  #startDecode = async (decoder: VideoDecoder) => {
    // Avoid starting new decode if already decoding or queue is too large
    if (this.#isDecodingInProgress || decoder.decodeQueueSize > 600) return;

    let endIndex = this.#decodeCursorIndex + 1;
    if (endIndex > this.samples.length) return; // No more samples

    this.#isDecodingInProgress = true;
    let hasValidFrameInGoP = false; // Check if the GoP contains any non-deleted frames
    // Find the end of the current GoP (next IDR frame)
    for (; endIndex < this.samples.length; endIndex++) {
      const sample = this.samples[endIndex];
      if (!hasValidFrameInGoP && !sample.deleted) {
        hasValidFrameInGoP = true;
      }
      if (sample.is_idr) break;
    }

    if (hasValidFrameInGoP) {
      const gopSamples = this.samples.slice(this.#decodeCursorIndex, endIndex);
      if (gopSamples[0]?.is_idr !== true) {
        // First sample of a GoP should ideally be an IDR frame
        console.warn(this.#logPrefix, 'First sample of GoP not an IDR frame');
      } else {
        const readStartTime = performance.now();
        // Convert MP4 samples to EncodedVideoChunks
        const chunks = await videoSamplesToEncodedChunks(
          gopSamples,
          this.localFileReader,
        );
        const readDuration = performance.now() - readStartTime;
        // Log if reading chunks took a long time
        if (readDuration > 1000) {
          const firstSample = gopSamples[0];
          const lastSample = gopSamples.at(-1)!;
          const rangeSize =
            lastSample.offset + lastSample.size - firstSample.offset;
          console.warn(
            this.#logPrefix,
            `Read video samples time cost: ${Math.round(
              readDuration,
            )}ms, file chunk size: ${rangeSize}`,
          );
        }

        // Check if decoder was closed while reading chunks
        if (decoder.state === 'closed') {
          this.#isDecodingInProgress = false;
          return;
        }

        this.#lastVideoFrameDuration = chunks[0]?.duration ?? 0; // Store duration for potential fix
        // Decode the GoP
        decodeGoP(decoder, chunks, {
          onDecodingError: (err) => {
            if (this.#useSoftwareDecoding) {
              // If already tried software decoding, throw error
              throw err;
            } else if (this.#outputFrameCount === 0) {
              // If no frames output yet, try downgrading to software decoding
              this.#useSoftwareDecoding = true;
              console.warn(
                this.#logPrefix,
                'Downgrade to software decode due to error:',
                err.message,
              );
              this.#reset(); // Reset with software decoding preference
            }
          },
        });
        this.#inputChunkCount += chunks.length; // Increment input chunk count
      }
    }
    this.#decodeCursorIndex = endIndex; // Move cursor to the end of the processed GoP
    this.#isDecodingInProgress = false;
  };

  /**
   * Resets the VideoDecoder instance.
   * Closes the current decoder, clears frame buffers, and creates a new decoder
   * configured for the specified time (or start if no time provided).
   * @param time - Optional time (microseconds) to seek to after reset.
   */
  #reset = (time?: number) => {
    this.#isDecodingInProgress = false;
    this.#decodedVideoFrames.forEach((frame) => frame.close()); // Close buffered frames
    this.#decodedVideoFrames = [];
    this.#predecodeError = false;

    // Determine the starting sample index for the new decoder
    if (time == null || time === 0) {
      this.#decodeCursorIndex = 0; // Start from the beginning
    } else {
      // Find the keyframe index at or before the target time
      let keyFrameIndex = 0;
      for (let i = 0; i < this.samples.length; i++) {
        const sample = this.samples[i];
        if (sample.is_idr) keyFrameIndex = i; // Update last known keyframe
        if (sample.cts < time) continue; // If sample is before target time, continue
        this.#decodeCursorIndex = keyFrameIndex; // Set cursor to the keyframe at/before time
        break;
      }
    }
    this.#inputChunkCount = 0;
    this.#outputFrameCount = 0;

    if (this.#decoder?.state !== 'closed') this.#decoder?.close(); // Close existing decoder

    // Prepare new decoder configuration, potentially preferring software decoding
    const decoderConfigWithFallback = {
      ...this.config,
      ...(this.#useSoftwareDecoding
        ? { hardwareAcceleration: 'prefer-software' as HardwarePreference }
        : {}),
    } as VideoDecoderConfig;

    this.#decoder = new VideoDecoder({
      output: (videoFrame) => {
        this.#outputFrameCount += 1;
        if (videoFrame.timestamp === -1) {
          // Placeholder frame, ignore
          videoFrame.close();
          return;
        }
        let resultVideoFrame = videoFrame;
        // If VideoFrame duration is null, use the last known duration
        if (videoFrame.duration == null) {
          resultVideoFrame = new VideoFrame(videoFrame, {
            duration: this.#lastVideoFrameDuration,
          });
          videoFrame.close(); // Close original frame
        }
        this.#decodedVideoFrames.push(resultVideoFrame); // Add to buffer
      },
      error: (err) => {
        if (err.message.includes('Codec reclaimed due to inactivity')) {
          // Decoder was closed by browser due to inactivity, can happen if tab is in background
          this.#decoder = null; // Mark decoder as null
          console.warn(this.#logPrefix, err.message);
          return;
        }
        const errorMsg = `${
          this.#logPrefix
        } VideoFinder VideoDecoder error: ${
          err.message
        }, config: ${JSON.stringify(
          decoderConfigWithFallback,
        )}, state: ${JSON.stringify(this.#getState())}`;
        console.error(errorMsg);
        throw Error(errorMsg); // Rethrow as a critical error
      },
    });
    this.#decoder.configure(decoderConfigWithFallback);
  };

  /**
   * Gets the current state of the VideoFrameFinder for debugging.
   * @returns An object containing state information.
   */
  #getState = () => ({
    time: this.#currentTimestamp,
    decoderState: this.#decoder?.state,
    decoderQueueSize: this.#decoder?.decodeQueueSize,
    decodeCursorIndex: this.#decodeCursorIndex,
    sampleLength: this.samples.length,
    inputChunkCount: this.#inputChunkCount,
    outputFrameCount: this.#outputFrameCount,
    cachedFrameCount: this.#decodedVideoFrames.length,
    isSoftwareDecoding: this.#useSoftwareDecoding,
    clipInstanceCount: CLIP_ID, // Global count of MP4Clip instances
    sleepCount: this.#sleepCount,
    memoryInfo: memoryUsageInfo(), // Browser memory usage if available
  });

  /**
   * Destroys the VideoFrameFinder, closing the decoder and file reader.
   */
  destroy = () => {
    if (this.#decoder?.state !== 'closed') this.#decoder?.close();
    this.#decoder = null;
    this.#currentAborter.abort = true; // Abort any ongoing operations
    this.#decodedVideoFrames.forEach((frame) => frame.close()); // Close buffered frames
    this.#decodedVideoFrames = [];
    this.localFileReader.close(); // Close the file reader
  };
}

/**
 * Finds the index of the sample that contains the given time.
 * @param time - The time in microseconds.
 * @param samples - An array of extended MP4 samples.
 * @returns The index of the matching sample, or 0 if not found or time is before first sample.
 */
function findIndexOfSamples(time: number, samples: ExtMP4Sample[]): number {
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    // Check if time falls within the sample's duration
    if (time >= sample.cts && time < sample.cts + sample.duration) {
      return i;
    }
    // If sample's start time is past the target time, no further samples will match
    if (sample.cts > time) break;
  }
  return 0; // Default to first sample if no exact match or time is early
}

/**
 * Manages audio frame decoding, resampling, and volume adjustment.
 * It efficiently seeks to the requested time, decodes audio chunks,
 * and provides PCM data.
 */
class AudioFrameFinder {
  #volume = 1; // Audio volume (0.0 to 1.0)
  #targetSampleRate; // Target sample rate for output PCM data
  #logPrefix: string; // Prefix for console logging

  constructor(
    public localFileReader: LocalFileReader, // Reader for the OPFS file
    public samples: ExtMP4Sample[], // Array of extended audio samples
    public config: AudioDecoderConfig, // Audio decoder configuration
    opts: { volume: number; targetSampleRate: number },
    logPrefix: string,
  ) {
    this.#volume = opts.volume;
    this.#targetSampleRate = opts.targetSampleRate;
    this.#logPrefix = `${logPrefix} AudioFrameFinder:`;
  }

  #audioChunksDecoder: ReturnType<typeof createAudioChunksDecoder> | null = null; // Decoder instance
  #currentAborter = { abort: false, startTime: performance.now() }; // Aborter for ongoing find operation

  /**
   * Finds and returns PCM audio data for the specified time.
   * @param time - The target time in microseconds.
   * @returns A Promise that resolves to an array of Float32Arrays (PCM data per channel).
   */
  find = async (time: number): Promise<Float32Array[]> => {
    // Determine if a reset is needed (significant time jump or decoder closed)
    const needsReset =
      time <= this.#currentTimestamp || // Seeking backwards
      time - this.#currentTimestamp > 0.1e6; // Seeking forward more than 100ms (heuristic)

    if (
      this.#audioChunksDecoder == null ||
      this.#audioChunksDecoder.state === 'closed' ||
      needsReset
    ) {
      this.#reset(); // Reset decoder
    }

    if (needsReset) {
      // If seeking, update current timestamp and find the starting sample index
      this.#currentTimestamp = time;
      this.#decodeCursorIndex = findIndexOfSamples(time, this.samples);
    }

    this.#currentAborter.abort = true; // Abort previous operation
    const deltaTime = time - this.#currentTimestamp; // Time difference from last find
    this.#currentTimestamp = time; // Update current time

    this.#currentAborter = { abort: false, startTime: performance.now() };

    // Calculate number of frames needed based on delta time and sample rate
    const pcmData = await this.#parseFrame(
      Math.ceil(deltaTime * (this.#targetSampleRate / 1e6)),
      this.#audioChunksDecoder,
      this.#currentAborter,
    );
    this.#sleepCount = 0; // Reset sleep counter
    return pcmData;
  };

  #currentTimestamp = 0; // Timestamp of the last requested audio data (microseconds)
  #decodeCursorIndex = 0; // Current index in the audio samples array for decoding
  #pcmDataBuffer: {
    frameCount: number; // Total number of frames in the buffer
    data: [Float32Array, Float32Array][]; // Buffered PCM data (stereo pairs)
  } = {
    frameCount: 0,
    data: [],
  };
  #sleepCount = 0; // Counter for how many times parsing has slept waiting for data

  /**
   * Internal method to parse audio frames until enough data for the requested duration is available.
   * Manages decoding, buffering, and error handling.
   * @param emitFrameCount - Number of PCM frames to emit.
   * @param decoder - The audio chunks decoder instance.
   * @param aborter - Abort controller for the current find operation.
   * @returns A Promise resolving to an array of Float32Arrays (PCM data).
   * @throws Error if decoding times out.
   */
  #parseFrame = async (
    emitFrameCount: number,
    decoder: ReturnType<typeof createAudioChunksDecoder> | null = null,
    aborter: { abort: boolean; startTime: number },
  ): Promise<Float32Array[]> => {
    if (
      decoder == null ||
      aborter.abort ||
      decoder.state === 'closed' ||
      emitFrameCount === 0
    ) {
      return []; // Return empty if invalid state or no frames needed
    }

    // Check if buffered data is sufficient
    const remainingFrameCount = this.#pcmDataBuffer.frameCount - emitFrameCount;
    if (remainingFrameCount > 0) {
      // If buffer is running low (less than 100ms of audio), start pre-decoding more
      if (remainingFrameCount < DEFAULT_AUDIO_CONF.sampleRate / 10) {
        this.#startDecode(decoder);
      }
      return emitAudioFrames(this.#pcmDataBuffer, emitFrameCount); // Emit requested frames from buffer
    }

    // If decoder is busy
    if (decoder.isDecoding) {
      // Timeout check
      if (performance.now() - aborter.startTime > 3000) {
        // 3 seconds timeout
        aborter.abort = true;
        throw Error(
          `${
            this.#logPrefix
          } MP4Clip.tick audio timeout, ${JSON.stringify(this.#getState())}`,
        );
      }
      // Wait and retry
      this.#sleepCount += 1;
      await sleep(15);
    } else if (this.#decodeCursorIndex >= this.samples.length - 1) {
      // All samples processed, emit remaining buffered data
      return emitAudioFrames(this.#pcmDataBuffer, this.#pcmDataBuffer.frameCount);
    } else {
      // Need more data, start decoding
      this.#startDecode(decoder);
    }
    // Recursively call to continue parsing
    return this.#parseFrame(emitFrameCount, decoder, aborter);
  };

  /**
   * Starts decoding a batch of audio samples.
   * @param decoder - The audio chunks decoder instance.
   */
  #startDecode = (decoder: ReturnType<typeof createAudioChunksDecoder>) => {
    const decodeBatchSize = 10; // Number of samples to decode at once
    // Don't start if decode queue is already large
    if (decoder.decodeQueueSize > decodeBatchSize) return;

    const samplesToDecode = [];
    let i = this.#decodeCursorIndex;
    // Collect next batch of non-deleted samples
    while (i < this.samples.length) {
      const sample = this.samples[i];
      i += 1;
      if (sample.deleted) continue;
      samplesToDecode.push(sample);
      if (samplesToDecode.length >= decodeBatchSize) break;
    }
    this.#decodeCursorIndex = i; // Update cursor

    // Convert to EncodedAudioChunks and send to decoder
    decoder.decode(
      samplesToDecode.map(
        (sample) =>
          new EncodedAudioChunk({
            type: 'key', // Assuming all audio chunks are key for simplicity here, might need adjustment
            timestamp: sample.cts,
            duration: sample.duration,
            data: sample.data!, // Non-null assertion as audio data is stored in ExtMP4Sample
          }),
      ),
    );
  };

  /**
   * Resets the AudioDecoder instance and clears buffers.
   * Creates a new decoder instance.
   */
  #reset = () => {
    this.#currentTimestamp = 0;
    this.#decodeCursorIndex = 0;
    this.#pcmDataBuffer = {
      frameCount: 0,
      data: [],
    };
    this.#audioChunksDecoder?.close(); // Close existing decoder
    // Create a new decoder
    this.#audioChunksDecoder = createAudioChunksDecoder(
      this.config,
      {
        resampleRate: DEFAULT_AUDIO_CONF.sampleRate, // Resample to default rate
        volume: this.#volume, // Apply volume
      },
      (pcmArray) => {
        // Callback for when decoded PCM data is available
        this.#pcmDataBuffer.data.push(
          pcmArray as [Float32Array, Float32Array], // Assuming stereo
        );
        this.#pcmDataBuffer.frameCount += pcmArray[0].length; // Update frame count
      },
      this.#logPrefix,
    );
  };

  /**
   * Gets the current state of the AudioFrameFinder for debugging.
   * @returns An object containing state information.
   */
  #getState = () => ({
    time: this.#currentTimestamp,
    decoderState: this.#audioChunksDecoder?.state,
    decoderQueueSize: this.#audioChunksDecoder?.decodeQueueSize,
    decodeCursorIndex: this.#decodeCursorIndex,
    sampleLength: this.samples.length,
    pcmFrameCountInBuffer: this.#pcmDataBuffer.frameCount,
    clipInstanceCount: CLIP_ID,
    sleepCount: this.#sleepCount,
    memoryInfo: memoryUsageInfo(),
  });

  /**
   * Destroys the AudioFrameFinder, closing the decoder.
   */
  destroy = () => {
    this.#audioChunksDecoder?.close();
    this.#audioChunksDecoder = null;
    this.#currentAborter.abort = true; // Abort ongoing operations
    this.#pcmDataBuffer = {
      // Clear buffer
      frameCount: 0,
      data: [],
    };
    this.localFileReader.close(); // Close file reader
  };
}

/**
 * Creates an audio decoder that processes EncodedAudioChunks,
 * handles resampling, volume adjustment, and outputs PCM data.
 * @param decoderConfig - Configuration for the AudioDecoder.
 * @param opts - Options for resampling rate and volume.
 * @param outputCb - Callback function to handle output PCM data.
 * @param logPrefix - Prefix for console logging.
 * @returns An object with methods to decode, close, and get decoder state.
 */
function createAudioChunksDecoder(
  decoderConfig: AudioDecoderConfig,
  opts: { resampleRate: number; volume: number },
  outputCb: (pcm: Float32Array[]) => void,
  logPrefix: string,
) {
  let inputChunkCount = 0; // Count of chunks sent to decoder
  let outputFrameCount = 0; // Count of frames (AudioData) output by decoder

  // Handles output from decoder or resampler queue
  const outputPCMHandler = (pcmArray: Float32Array[]) => {
    outputFrameCount += 1;
    if (pcmArray.length === 0) return;

    // Apply volume adjustment
    if (opts.volume !== 1) {
      for (const pcmChannel of pcmArray) {
        for (let i = 0; i < pcmChannel.length; i++) {
          pcmChannel[i] *= opts.volume;
        }
      }
    }

    // Ensure stereo output (duplicate channel if mono)
    if (pcmArray.length === 1) {
      pcmArray = [pcmArray[0], pcmArray[0]];
    }

    outputCb(pcmArray); // Call the main output callback
  };

  // Create a promise queue for resampling to ensure ordered output
  const resampleQueue = createPromiseQueue<Float32Array[]>(outputPCMHandler);

  const needsResampling = opts.resampleRate !== decoderConfig.sampleRate;
  let audioDecoder = new AudioDecoder({
    output: (audioData) => {
      const pcmData = extractPCM4AudioData(audioData); // Extract PCM from AudioData
      if (needsResampling) {
        // If resampling is needed, add a resampling task to the queue
        resampleQueue(() =>
          audioResample(pcmData, audioData.sampleRate, {
            rate: opts.resampleRate,
            chanCount: audioData.numberOfChannels,
          }),
        );
      } else {
        // Otherwise, handle PCM data directly
        outputPCMHandler(pcmData);
      }
      audioData.close(); // Close the AudioData object
    },
    error: (err) => {
      if (err.message.includes('Codec reclaimed due to inactivity')) {
        return; // Ignore inactivity errors
      }
      handleDecodeError(
        `${logPrefix} createAudioChunksDecoder AudioDecoder error`,
        err as Error,
      );
    },
  });
  audioDecoder.configure(decoderConfig);

  // Helper to format and throw decoding errors
  function handleDecodeError(prefixStr: string, err: Error) {
    const errorMsg = `${prefixStr}: ${
      (err as Error).message
    }, state: ${JSON.stringify({
      queueSize: audioDecoder.decodeQueueSize,
      state: audioDecoder.state,
      inputChunkCount,
      outputFrameCount,
    })}`;
    console.error(errorMsg);
    throw Error(errorMsg);
  }

  return {
    decode(chunks: EncodedAudioChunk[]) {
      inputChunkCount += chunks.length;
      try {
        for (const chunk of chunks) audioDecoder.decode(chunk);
      } catch (err) {
        handleDecodeError(
          `${logPrefix} decode audio chunk error`,
          err as Error,
        );
      }
    },
    close() {
      if (audioDecoder.state !== 'closed') audioDecoder.close();
    },
    get isDecoding() {
      // True if there are more inputs than outputs and decoder queue has items
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
 * Creates a queue that executes asynchronous tasks and emits their results in order.
 * @param onResult - Callback function to handle each result.
 * @returns A function to add new tasks to the queue.
 */
function createPromiseQueue<T extends any>(onResult: (data: T) => void) {
  const resultsCache: T[] = []; // Cache for results, indexed by their add order
  let waitingIndex = 0; // Index of the next result to emit

  // Stores a result in the cache and tries to emit results in order
  function storeAndEmit(result: T, emitIndex: number) {
    resultsCache[emitIndex] = result;
    tryEmit();
  }

  // Emits results from the cache that are in sequence
  function tryEmit() {
    const result = resultsCache[waitingIndex];
    if (result == null) return; // If the next expected result isn't there, wait
    onResult(result); // Emit the result

    waitingIndex += 1; // Move to next expected index
    tryEmit(); // Try to emit further results
  }

  let addIndex = 0; // Index for newly added tasks
  return (task: () => Promise<T>) => {
    const emitIndexForTask = addIndex;
    addIndex += 1;
    task()
      .then((result) => storeAndEmit(result, emitIndexForTask))
      .catch((err) => storeAndEmit(err, emitIndexForTask)); // Store errors too to maintain order
  };
}

/**
 * Extracts a specified number of audio frames from the PCM data buffer.
 * Modifies the buffer by removing the emitted frames.
 * @param pcmDataBuffer - The buffer containing PCM data.
 * @param emitFrameCount - The number of frames to emit.
 * @returns An array of two Float32Arrays (stereo PCM data).
 */
function emitAudioFrames(
  pcmDataBuffer: {
    frameCount: number;
    data: [Float32Array, Float32Array][];
  },
  emitFrameCount: number,
): [Float32Array, Float32Array] {
  // todo: perf - Consider reusing memory space for audio arrays instead of creating new ones each time
  const audioOutput = [
    new Float32Array(emitFrameCount),
    new Float32Array(emitFrameCount),
  ];
  let currentOffset = 0;
  let bufferIndex = 0;

  // Iterate through the buffered data chunks
  for (; bufferIndex < pcmDataBuffer.data.length; ) {
    const [channel0, channel1] = pcmDataBuffer.data[bufferIndex];
    // If the current chunk is larger than needed to fill emitFrameCount
    if (currentOffset + channel0.length > emitFrameCount) {
      const framesToCopy = emitFrameCount - currentOffset;
      audioOutput[0].set(channel0.subarray(0, framesToCopy), currentOffset);
      audioOutput[1].set(channel1.subarray(0, framesToCopy), currentOffset);
      // Update the chunk in the buffer to remove the copied part
      pcmDataBuffer.data[bufferIndex][0] = channel0.subarray(
        framesToCopy,
        channel0.length,
      );
      pcmDataBuffer.data[bufferIndex][1] = channel1.subarray(
        framesToCopy,
        channel1.length,
      );
      break; // All needed frames have been copied
    } else {
      // If the current chunk fits entirely, copy it all
      audioOutput[0].set(channel0, currentOffset);
      audioOutput[1].set(channel1, currentOffset);
      currentOffset += channel0.length;
      bufferIndex++; // Move to the next chunk
    }
  }
  // Remove processed chunks from the buffer
  pcmDataBuffer.data = pcmDataBuffer.data.slice(bufferIndex);
  pcmDataBuffer.frameCount -= emitFrameCount; // Update total frame count in buffer
  return audioOutput;
}

/**
 * Converts an array of video MP4Samples into EncodedVideoChunks.
 * Reads sample data from the OPFS file. Optimizes reads for small total sizes.
 * @param samples - Array of extended MP4 video samples.
 * @param reader - Reader for the OPFS file.
 * @returns A Promise that resolves to an array of EncodedVideoChunks.
 */
async function videoSamplesToEncodedChunks(
  samples: ExtMP4Sample[],
  reader: Awaited<ReturnType<OPFSToolFile['createReader']>>,
): Promise<EncodedVideoChunk[]> {
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  if (lastSample == null) return []; // No samples to convert

  // Calculate total size of data range for these samples
  const rangeSize =
    lastSample.offset + lastSample.size - firstSample.offset;

  // If total size is less than 30MB, read all data in one go to reduce I/O operations
  if (rangeSize < 30e6) {
    const data = new Uint8Array(
      await reader.read(rangeSize, { at: firstSample.offset }),
    );
    return samples.map((sample) => {
      const offsetInReadData = sample.offset - firstSample.offset;
      return new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta', // Mark keyframes (sync samples)
        timestamp: sample.cts,
        duration: sample.duration,
        data: data.subarray(
          offsetInReadData,
          offsetInReadData + sample.size,
        ),
      });
    });
  }

  // If total size is large, read each sample's data individually
  return await Promise.all(
    samples.map(async (sample) => {
      return new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: sample.cts,
        duration: sample.duration,
        data: await reader.read(sample.size, {
          at: sample.offset, // Read data at the specific sample offset
        }),
      });
    }),
  );
}

/**
 * Creates a function that converts VideoFrames to image Blobs using OffscreenCanvas.
 * @param width - Target width of the image.
 * @param height - Target height of the image.
 * @param opts - Image encoding options for `convertToBlob`.
 * @returns An asynchronous function that takes a VideoFrame and returns a Promise resolving to a Blob.
 */
function createVF2BlobConverter(
  width: number,
  height: number,
  opts?: ImageEncodeOptions,
) {
  const canvas = new OffscreenCanvas(width, height); // Create an offscreen canvas
  const context = canvas.getContext('2d')!; // Get 2D rendering context (non-null assertion)

  return async (videoFrame: VideoFrame): Promise<Blob> => {
    context.drawImage(videoFrame, 0, 0, width, height); // Draw VideoFrame onto canvas
    videoFrame.close(); // Close the VideoFrame to free resources
    const blob = await canvas.convertToBlob(opts); // Convert canvas content to Blob
    return blob;
  };
}

/**
 * Splits an array of video samples into two arrays based on a given time.
 * The split aims to preserve GoP structures.
 * @param videoSamples - The array of video samples to split.
 * @param time - The time in microseconds at which to split.
 * @returns An array containing two arrays of video samples (pre-split and post-split), or an empty array if no samples.
 * @throws Error if no video sample is found at the given time.
 */
function splitVideoSampleByTime(
  videoSamples: ExtMP4Sample[],
  time: number,
): [] | [ExtMP4Sample[] | undefined, ExtMP4Sample[] | undefined] {
  if (videoSamples.length === 0) return [];
  let gopStartIndex = 0; // Start index of the GoP containing the split point
  let gopEndIndex = 0; // End index of the GoP containing the split point (exclusive, or length if last GoP)
  let hitIndex = -1; // Index of the sample immediately before or at the split time

  // Iterate through samples to find the split point and relevant GoP boundaries
  for (let i = 0; i < videoSamples.length; i++) {
    const sample = videoSamples[i];
    // Find the sample that is active right before the split time
    if (hitIndex === -1 && time < sample.cts) hitIndex = i - 1;
    // Identify GoP boundaries based on IDR frames
    if (sample.is_idr) {
      if (hitIndex === -1) {
        // If split time is before this IDR, this IDR starts the GoP of interest
        gopStartIndex = i;
      } else {
        // If split time was in a previous GoP, this IDR marks the end of that GoP
        gopEndIndex = i;
        break;
      }
    }
  }

  const hitSample = videoSamples[hitIndex];
  if (hitSample == null) throw Error('Not found video sample by time');

  // Create the "pre-split" slice
  // It includes samples up to the start of the next GoP, or all samples if it's the last GoP
  const preSlice = videoSamples
    .slice(0, gopEndIndex === 0 ? videoSamples.length : gopEndIndex)
    .map((sample) => ({ ...sample })); // Shallow copy samples
  // Mark samples in the GoP that are after the split time as deleted
  for (let i = gopStartIndex; i < preSlice.length; i++) {
    const sample = preSlice[i];
    if (time < sample.cts) {
      sample.deleted = true;
      sample.cts = -1; // Mark as invalid timestamp
    }
  }
  fixFirstBlackFrame(preSlice); // Attempt to fix potential black frame at the start of this slice

  // Create the "post-split" slice
  // It starts from the IDR frame of the GoP containing the split point (or the hit sample if it's an IDR)
  const postSlice = videoSamples
    .slice(hitSample.is_idr ? hitIndex : gopStartIndex)
    .map((sample) => ({ ...sample, cts: sample.cts - time })); // Adjust timestamps relative to the split time

  // Mark samples in the post-slice that are now before time 0 (due to adjustment) as deleted
  for (const sample of postSlice) {
    if (sample.cts < 0) {
      sample.deleted = true;
      sample.cts = -1;
    }
  }
  fixFirstBlackFrame(postSlice); // Fix potential black frame at the start of this new slice

  return [preSlice, postSlice];
}

/**
 * Splits an array of audio samples into two arrays based on a given time.
 * @param audioSamples - The array of audio samples to split.
 * @param time - The time in microseconds at which to split.
 * @returns An array containing two arrays of audio samples (pre-split and post-split), or an empty array if no samples.
 * @throws Error if no audio sample is found at or after the given time (unless it's the very end).
 */
function splitAudioSampleByTime(
  audioSamples: ExtMP4Sample[],
  time: number,
): [] | [ExtMP4Sample[], ExtMP4Sample[]] {
  if (audioSamples.length === 0) return [];
  let hitIndex = -1; // Index of the first sample that starts at or after the split time
  for (let i = 0; i < audioSamples.length; i++) {
    const sample = audioSamples[i];
    if (time > sample.cts) continue; // If sample is before split time, continue
    hitIndex = i;
    break;
  }
  if (hitIndex === -1 && time < audioSamples.at(-1)!.cts + audioSamples.at(-1)!.duration) {
    // If time is within the last sample, effectively split means all samples are in preSlice
    hitIndex = audioSamples.length;
  } else if (hitIndex === -1) {
    throw Error('Not found audio sample by time for splitting');
  }

  // Pre-split slice includes all samples before hitIndex
  const preSlice = audioSamples.slice(0, hitIndex).map((s) => ({ ...s }));
  // Post-split slice includes samples from hitIndex onwards, with adjusted timestamps
  const postSlice = audioSamples
    .slice(hitIndex)
    .map((s) => ({ ...s, cts: s.cts - time })); // Adjust CTS relative to split time
  return [preSlice, postSlice];
}

/**
 * Decodes a Group of Pictures (GoP) using the provided VideoDecoder.
 * Handles potential errors and includes a mechanism to flush the decoder.
 * @param decoder - The VideoDecoder instance.
 * @param chunks - An array of EncodedVideoChunks representing the GoP.
 * @param opts - Options, including an error callback.
 */
function decodeGoP(
  decoder: VideoDecoder,
  chunks: EncodedVideoChunk[],
  opts: {
    onDecodingError?: (err: Error) => void; // Callback for decoding errors
  },
) {
  if (decoder.state !== 'configured') return; // Decoder must be configured
  // Send all chunks in the GoP to the decoder
  for (let i = 0; i < chunks.length; i++) decoder.decode(chunks[i]);

  // Flushing is important after a GoP, especially if the next frame isn't guaranteed to be an IDR.
  // However, on some Windows devices, `flush()` might not resolve, so it's not awaited.
  decoder.flush().catch((err) => {
    if (!(err instanceof Error)) throw err; // Rethrow if not an Error instance
    // Handle specific decoding error if callback is provided
    if (
      err.message.includes('Decoding error') &&
      opts.onDecodingError != null
    ) {
      opts.onDecodingError(err);
      return;
    }
    // If the error is due to decoder closure (e.g., during reset), it's expected.
    if (!err.message.includes('Aborted due to close')) {
      throw err; // Rethrow other unexpected errors
    }
  });
}

/**
 * Finds the offset of the IDR NALU (Network Abstraction Layer Unit) within a raw H.264/AVC or H.265/HEVC sample.
 * This is used to skip potential preceding NALUs (like SEI messages) that might cause decoding issues.
 * @param u8Arr - Uint8Array containing the raw sample data.
 * @param type - Codec type ('avc1' for H.264, 'hvc1' for H.265).
 * @returns The offset of the IDR NALU, or -1 if not found or type is unsupported.
 */
function findIDRNALUOffset(
  u8Arr: Uint8Array,
  type: MP4Sample['description']['type'],
): { offset: number } {
  // Only applicable for AVC and HEVC
  if (type !== 'avc1' && type !== 'hvc1') return { offset: 0 }; // Treat as no offset for other types

  const dataView = new DataView(u8Arr.buffer, u8Arr.byteOffset, u8Arr.byteLength);
  let currentOffset = 0;
  // Iterate through NALUs (typically prefixed with a 4-byte length)
  for (; currentOffset < u8Arr.byteLength - 4; ) {
    // NALU type is in the byte following the 4-byte length prefix
    if (type === 'avc1') {
      // For AVC, IDR NALU type is 5 (nal_unit_type === 5)
      // The NALU header is 1 byte. The type is the lower 5 bits.
      if ((dataView.getUint8(currentOffset + 4) & 0x1f) === 5) {
        return { offset: currentOffset };
      }
    } else if (type === 'hvc1') {
      // For HEVC, IDR NALU types are 19 (IDR_W_RADL) and 20 (IDR_N_LP)
      // The NALU header is 2 bytes. Type is bits 1-6 of the first byte after length.
      const nalUnitType = (dataView.getUint8(currentOffset + 4) >> 1) & 0x3f;
      if (nalUnitType === 19 || nalUnitType === 20) {
        return { offset: currentOffset };
      }
    }
    // Move to the next NALU: current offset + 4-byte length field + length of NALU
    currentOffset += dataView.getUint32(currentOffset) + 4;
  }
  return { offset: -1 }; // IDR NALU not found
}

/**
 * Generates thumbnails from keyframes within a specified time range.
 * @param samples - Array of all video samples.
 * @param localFile - The OPFS file object.
 * @param decoderConfig - Video decoder configuration.
 * @param abortSignal - Signal to abort the operation.
 * @param timeRange - Object with start and end times (microseconds).
 * @param onOutput - Callback function for each decoded frame and completion status.
 * @param logPrefix - Prefix for console logging.
 */
async function thumbnailByKeyFrame(
  samples: ExtMP4Sample[],
  localFile: OPFSToolFile,
  decoderConfig: VideoDecoderConfig,
  abortSignal: AbortSignal,
  timeRange: { start: number; end: number },
  onOutput: (vf: VideoFrame | null, done: boolean) => void,
  logPrefix: string,
) {
  const fileReader = await localFile.createReader();

  // Filter for keyframes (sync samples) within the specified time range that are not deleted
  const keyframeSamples = samples.filter(
    (sample) =>
      !sample.deleted &&
      sample.is_sync &&
      sample.cts >= timeRange.start &&
      sample.cts <= timeRange.end,
  );
  // Convert these samples to EncodedVideoChunks
  const chunks = await videoSamplesToEncodedChunks(keyframeSamples, fileReader);

  if (chunks.length === 0 || abortSignal.aborted) {
    fileReader.close();
    onOutput(null, true); // Signal completion if no chunks or aborted
    return;
  }

  let outputCount = 0; // Counter for output frames

  // Function to create and configure a VideoDecoder for thumbnails
  function createThumbnailDecoder(useSoftwareFallback = false) {
    const currentDecoderConfig = {
      ...decoderConfig,
      ...(useSoftwareFallback
        ? { hardwareAcceleration: 'prefer-software' as HardwarePreference }
        : {}),
    } as VideoDecoderConfig;

    const decoder = new VideoDecoder({
      output: (videoFrame) => {
        outputCount += 1;
        const isDone = outputCount === chunks.length; // Check if all chunks processed
        onOutput(videoFrame, isDone); // Output the frame
        if (isDone) {
          // If done, clean up
          fileReader.close();
          if (decoder.state !== 'closed') decoder.close();
        }
      },
      error: (err) => {
        const errorMsg = `${logPrefix} thumbnails decoder error: ${
          err.message
        }, config: ${JSON.stringify(
          currentDecoderConfig,
        )}, state: ${JSON.stringify({
          queueSize: decoder.decodeQueueSize,
          state: decoder.state,
          outputCount,
          inputChunkCount: chunks.length,
        })}`;
        console.error(errorMsg);
        // Don't rethrow here, allow potential fallback or signal completion
        onOutput(null, true); // Signal completion with error
        fileReader.close();
        if (decoder.state !== 'closed') decoder.close();
      },
    });
    // Abort decoder if the main abort signal is triggered
    abortSignal.addEventListener('abort', () => {
      fileReader.close();
      if (decoder.state !== 'closed') decoder.close();
    });
    decoder.configure(currentDecoderConfig);
    return decoder;
  }

  // Attempt to decode with default (hardware-accelerated if preferred) decoder
  decodeGoP(createThumbnailDecoder(), chunks, {
    onDecodingError: (err) => {
      console.warn(logPrefix, 'thumbnailsByKeyFrame error:', err.message);
      // If decoding fails and no frames were output, try downgrading to software decoding
      if (outputCount === 0 && !abortSignal.aborted) {
        console.info(
          logPrefix,
          'Retrying thumbnail generation with software decoding.',
        );
        decodeGoP(createThumbnailDecoder(true), chunks, {
          onDecodingError: (retryErr) => {
            // If software decoding also fails
            console.error(
              logPrefix,
              'thumbnailsByKeyFrame retry with software decode failed:',
              retryErr.message,
            );
            onOutput(null, true); // Signal completion with error
            fileReader.close();
          },
        });
      } else {
        // If some frames were output or aborted, just signal completion
        onOutput(null, true);
        fileReader.close();
      }
    },
  });
}

/**
 * Attempts to fix a common issue where the first frame of a video might be black
 * if its timestamp (CTS) has a significant offset from zero.
 * This function adjusts the CTS and duration of the first non-deleted sample
 * if its CTS is small (less than 200ms, an empirical value).
 * @param samples - Array of extended video samples.
 * @param logPrefix - Optional prefix for console logging.
 */
function fixFirstBlackFrame(samples: ExtMP4Sample[], logPrefix?: string) {
  let iframeCount = 0; // Counter for I-frames encountered
  let minCtsSample: ExtMP4Sample | null = null; // Sample with the minimum CTS found so far

  // Iterate through samples to find the earliest frame (smallest CTS)
  // Limit search to roughly the first GoP (up to the second I-frame)
  for (const sample of samples) {
    if (sample.deleted) continue; // Skip deleted samples

    if (sample.is_sync) iframeCount += 1; // Count I-frames
    if (iframeCount >= 2) break; // Stop after the start of the second GoP

    // Update minCtsSample if current sample has a smaller CTS
    if (minCtsSample == null || sample.cts < minCtsSample.cts) {
      minCtsSample = sample;
    }
  }

  // If an early frame is found (CTS < 200ms), adjust its CTS to 0 and add the original CTS to its duration
  // This effectively shifts the start time of the video to zero if the initial offset is small.
  if (minCtsSample != null && minCtsSample.cts < 200e3) {
    if (logPrefix && minCtsSample.cts > 0) {
      // Log if a fix is applied
      console.log(
        logPrefix,
        `Fixing first black frame, original CTS: ${minCtsSample.cts}, new CTS: 0`,
      );
    }
    minCtsSample.duration += minCtsSample.cts; // Add original CTS to duration
    minCtsSample.cts = 0; // Set CTS to 0
  }
}

/**
 * Retrieves browser memory usage information if available via `performance.memory`.
 * @returns An object with memory usage details, or an empty object if API is not available.
 */
function memoryUsageInfo(): object {
  try {
    // @ts-ignore - performance.memory is not standard but available in Chromium-based browsers
    const memory = performance.memory;
    if (!memory) return {};
    return {
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
      totalJSHeapSize: memory.totalJSHeapSize,
      usedJSHeapSize: memory.usedJSHeapSize,
      percentUsed: (memory.usedJSHeapSize / memory.jsHeapSizeLimit).toFixed(3),
      percentTotal: (memory.totalJSHeapSize / memory.jsHeapSizeLimit).toFixed(
        3,
      ),
    };
  } catch (err) {
    return {}; // Return empty if API access fails
  }
}
```
