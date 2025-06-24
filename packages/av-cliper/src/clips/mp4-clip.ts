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

// Options for configuring an MP4Clip instance
// TODO-REFACTOR: Consider consolidating MP4ClipOpts and MP4DecoderConfig, or nesting decoder configs within MP4ClipOpts
// to have a single options object for the MP4Clip constructor.
interface MP4ClipOpts {
  audio?: boolean | { volume: number }; // Audio processing options (enable/disable or set volume)
  decoderConfig?: {
    video: VideoDecoderConfig | null; // Video decoder configuration
    audio: AudioDecoderConfig | null; // Audio decoder configuration
  };
  /**
   * Unsafe option, may be deprecated at any time.
   * Used to specify hardware acceleration preference for video decoding.
   */
  __unsafe_hardwareAcceleration__?: HardwarePreference;
  /**
   * If true, operations like clone, split will create a new copy of the underlying file.
   * Defaults to false (sharing the file).
   */
  deepClone?: boolean;
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
// REFACTOR-IDEA: The MP4Clip class is quite large. Consider if VideoFrameFinder and AudioFrameFinder
// could be moved to separate files to improve modularity and readability of mp4-clip.ts.
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
  // This will be populated from opts.decoderConfig or parsed from the file
  #decoderConfig: {
    video: VideoDecoderConfig | null;
    audio: AudioDecoderConfig | null;
  } = {
    video: null,
    audio: null,
  };

  // Options passed to the constructor
  #opts: Required<MP4ClipOpts>; // Now includes deepClone default

  constructor(
    source: OPFSToolFile | ReadableStream<Uint8Array> | MPClipCloneArgs,
    opts: MP4ClipOpts = {}, // User-provided options
  ) {
    this.#logPrefix = `MP4Clip id:${this.#insId}:`;

    // Initialize #opts with defaults, including for deepClone
    this.#opts = {
      audio: true,
      deepClone: false, // Default for deepClone
      ...opts, // User options override defaults
    };
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

    // Set volume based on the final #opts
    this.#volume =
      typeof this.#opts.audio === 'object' && 'volume' in this.#opts.audio
        ? this.#opts.audio.volume
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
        // decoderConf is replaced by parsedDecoderConfig in the return type of mp4FileToSamples
        parsedDecoderConfig, // This will come from mp4FileToSamples or MPClipCloneArgs. Its type is { video: VideoDecoderConfig | null, audio: AudioDecoderConfig | null }
        headerBoxPos,
      }) => {
        this.#videoSamples = videoSamples;
        this.#audioSamples = audioSamples;
        this.#headerBoxPos = headerBoxPos;

        // Start with the decoderConfig from options, or the parsed one
        let baseDecoderConfig = this.#opts.decoderConfig ?? parsedDecoderConfig;

        // Prepare the final decoder config, potentially overriding hardwareAcceleration
        this.#decoderConfig = {
          video:
            baseDecoderConfig.video == null
              ? null
              : {
                  ...baseDecoderConfig.video,
                  // Apply hardware acceleration preference from options if it's specifically set
                  ...(this.#opts.__unsafe_hardwareAcceleration__ != null && {
                    hardwareAcceleration: this.#opts.__unsafe_hardwareAcceleration__,
                  }),
                },
          audio: baseDecoderConfig.audio,
        };

        // Generate decoder instances (VideoFrameFinder, AudioFrameFinder)
        const { videoFrameFinder, audioFrameFinder } = genDecoder(
          this.#decoderConfig, // Use the now fully resolved and stored decoderConfig
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
          this.#decoderConfig, // Use the resolved decoderConfig
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

  #thumbAborter = new AbortController();

  private async _thumbnailsByStep(
    vfToBlobConverter: (vf: VideoFrame) => Promise<Blob>,
    aborterSignal: AbortSignal,
    addPNGPromise: (vf: VideoFrame) => void,
    opts: Required<ThumbnailOpts>, // Full options needed here
  ): Promise<void> {
    if (this.#videoFrameFinder == null) {
      console.warn(this.#logPrefix, 'VideoFrameFinder not available for thumbnailsByStep');
      return;
    }

    let currentTime = opts.start;
    while (currentTime <= opts.end && !aborterSignal.aborted) {
      const videoFrame = await this.#videoFrameFinder.find(currentTime, 'fast');
      if (videoFrame) {
        addPNGPromise(videoFrame);
      }
      currentTime += opts.step;
      if (currentTime % (opts.step * 10) < opts.step) await sleep(0); // Yield periodically
    }
  }

  private async _thumbnailsByKeyframes(
    vfToBlobConverter: (vf: VideoFrame) => Promise<Blob>,
    aborterSignal: AbortSignal,
    addPNGPromise: (vf: VideoFrame) => void,
    resolveAllPNGs: () => void, // Callback to resolve the main promise
    opts: Required<ThumbnailOpts>, // Full options needed here
  ): Promise<void> {
    if (this.#decoderConfig.video == null) {
       console.warn(this.#logPrefix, 'Video config not available for thumbnailsByKeyframes');
       resolveAllPNGs(); // Resolve empty if no config
       return;
    }

    await thumbnailByKeyFrame(
      this.#videoSamples,
      this.#localFile,
      this.#decoderConfig.video, // Use the instance's config
      aborterSignal,
      { start: opts.start, end: opts.end },
      (videoFrame, done) => {
        if (aborterSignal.aborted) {
          videoFrame?.close();
          return;
        }
        if (videoFrame != null) {
          addPNGPromise(videoFrame);
        }
        if (done) {
          resolveAllPNGs();
        }
      },
      this.#logPrefix,
    );
  }

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
    partialOpts?: Partial<ThumbnailOpts>,
  ): Promise<Array<{ ts: number; img: Blob }>> {
    this.#thumbAborter.abort();
    this.#thumbAborter = new AbortController();
    const aborterSignal = this.#thumbAborter.signal;

    await this.ready;
    const abortMsg = 'generate thumbnails aborted';
    if (aborterSignal.aborted) throw Error(abortMsg);

    if (this.#decoderConfig.video == null || this.#videoSamples.length === 0) {
      return [];
    }

    const { width, height, duration } = this.#meta;
    const vfToBlobConverter = createVF2BlobConverter(
      imgWidth,
      Math.round(height * (imgWidth / width)),
      { quality: 0.1, type: 'image/png' },
    );

    const fullOpts: Required<ThumbnailOpts> = {
      start: 0,
      end: duration,
      step: 0, // Default to keyframe-based
      ...(partialOpts ?? {}),
    };
    // Ensure step is explicitly 0 if not provided or invalid, for clarity in delegation
    if (partialOpts?.step == null || partialOpts.step <= 0) {
      fullOpts.step = 0;
    }

    return new Promise<Array<{ ts: number; img: Blob }>>(
      async (resolve, reject) => {
        let pngPromises: Array<{ ts: number; img: Promise<Blob> }> = [];
        aborterSignal.addEventListener('abort', () => reject(Error(abortMsg)));

        const addPNGPromise = (videoFrame: VideoFrame) => {
          if (aborterSignal.aborted) {
            videoFrame?.close();
            return;
          }
          pngPromises.push({
            ts: videoFrame.timestamp,
            img: vfToBlobConverter(videoFrame),
          });
        };

        const resolveAllPNGs = async () => {
          if (aborterSignal.aborted) {
            // Do not resolve or reject if already aborted, as reject might have been called.
            return;
          }
          try {
            const results = await Promise.all(
              pngPromises.map(async (it) => ({
                ts: it.ts,
                img: await it.img,
              })),
            );
            resolve(results);
          } catch (err) {
            if (!aborterSignal.aborted) reject(err);
          }
        };

        if (fullOpts.step > 0) {
          await this._thumbnailsByStep(
            vfToBlobConverter,
            aborterSignal,
            addPNGPromise,
            fullOpts,
          );
          // After _thumbnailsByStep finishes (all frames found and promises added), resolve them.
          await resolveAllPNGs();
        } else {
          // _thumbnailsByKeyframes will call resolveAllPNGs internally when done,
          // because thumbnailByKeyFrame has a `done` callback.
          await this._thumbnailsByKeyframes(
            vfToBlobConverter,
            aborterSignal,
            addPNGPromise,
            resolveAllPNGs, // Pass the resolver
            fullOpts,
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
  // TODO-REFACTOR: The `split` and `splitTrack` methods create new MP4Clip instances that share
  // the `localFile` and `decoderConfig`. This is efficient but means changes to the underlying
  // file or assumptions based on the original config could affect cloned/split clips.
  // Consider if an option for "deep cloning" or more isolated state would be beneficial for some use cases,
  // though it would come with performance/memory costs.
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

    let fileForPreClip = this.#localFile;
    let fileForPostClip = this.#localFile;

    if (this.#opts.deepClone) {
      try {
        console.info(this.#logPrefix, 'Deep cloning files for MP4Clip.split()');
        // Sequentially copy for now, could be parallelized if #copyLocalFile is safe for it
        fileForPreClip = await this.#copyLocalFile(this.#localFile);
        fileForPostClip = await this.#copyLocalFile(this.#localFile);
      } catch (error) {
        console.error(this.#logPrefix, 'Failed to deep clone files for split, falling back to shallow clone', error);
        // Fallback to original file if copying fails
        fileForPreClip = this.#localFile;
        fileForPostClip = this.#localFile;
        // If one copy succeeded but the other failed, we might have an intermediate state.
        // For simplicity here, if any copy fails, both use the original.
        // A more robust strategy might try to clean up successful copies if subsequent ones fail.
      }
    }

    // Options for the new clips should inherit from the parent, including its deepClone preference for future operations.
    const clipOptsTemplate: MP4ClipOpts = {
      ...this.#opts, // Inherit parent's options (including its deepClone setting)
      decoderConfig: { ...this.#decoderConfig }, // Pass a copy of the resolved decoder config
    };

    const preClip = new MP4Clip(
      {
        localFile: fileForPreClip,
        videoSamples: preVideoSlice ?? [],
        audioSamples: preAudioSlice ?? [],
        parsedDecoderConfig: this.#decoderConfig,
        headerBoxPos: [...this.#headerBoxPos],
      },
      // Ensure the new clip knows its own deepClone setting, inherited from parent
      { ...clipOptsTemplate },
    );

    const postClip = new MP4Clip(
      {
        localFile: fileForPostClip,
        videoSamples: postVideoSlice ?? [],
        audioSamples: postAudioSlice ?? [],
        parsedDecoderConfig: this.#decoderConfig,
        headerBoxPos: [...this.#headerBoxPos],
      },
      { ...clipOptsTemplate },
    );

    // Wait for both new clips to be ready
    await Promise.all([preClip.ready, postClip.ready]);

    return [preClip, postClip] as [this, this];
  }

  /**
   * Creates a new MP4Clip instance.
   * By default, it's a shallow copy (shares the underlying file).
   * If `opts.deepClone` is true, it performs a deep copy of the file.
   * @param opts - Optional `MP4ClipOpts` to override options for the cloned clip, including `deepClone`.
   * @returns A Promise that resolves to the cloned MP4Clip instance.
   */
  async clone(opts?: MP4ClipOpts): Promise<this> {
    await this.ready;

    // Determine if deep cloning is needed.
    // Priority:
    // 1. opts.deepClone if explicitly provided in this clone() call.
    // 2. this.#opts.deepClone (original clip's setting) if opts.deepClone is not provided.
    const deepCloneFile = opts?.deepClone ?? this.#opts.deepClone;

    let localFileForClone = this.#localFile;
    if (deepCloneFile) {
      try {
        console.info(this.#logPrefix, 'Deep cloning file for MP4Clip.clone()');
        localFileForClone = await this.#copyLocalFile(this.#localFile);
      } catch (error) {
        console.error(this.#logPrefix, 'Failed to deep clone file, falling back to shallow clone for .clone()', error);
        // Fallback to using the original file if copy fails. Consider if this is the best strategy.
        localFileForClone = this.#localFile;
      }
    }

    // Merge options: start with original clip's opts, then apply specific clone opts.
    // The decoderConfig from the current instance should be the default for the clone.
    const clonedOpts: MP4ClipOpts = {
      ...this.#opts, // Start with original's full opts (incl. audio settings, deepClone default for future ops)
      decoderConfig: { ...this.#decoderConfig }, // Pass a copy of the resolved decoder config
      ...(opts ?? {}), // Override with any options passed directly to clone()
      deepClone: deepCloneFile, // Ensure the resolved deepClone decision is part of the new clip's opts
    };

    const clip = new MP4Clip(
      {
        localFile: localFileForClone, // Use original or copied file
        videoSamples: [...this.#videoSamples],
        audioSamples: [...this.#audioSamples],
        parsedDecoderConfig: this.#decoderConfig, // Pass current decoderConfig as parsed for the clone
        headerBoxPos: [...this.#headerBoxPos],
      },
      clonedOpts,
    );
    await clip.ready;
    clip.tickInterceptor = this.tickInterceptor;
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
      let fileForVideoClip = this.#localFile;
      if (this.#opts.deepClone) {
        try {
          console.info(this.#logPrefix, 'Deep cloning file for video-only clip in splitTrack()');
          fileForVideoClip = await this.#copyLocalFile(this.#localFile);
        } catch (error) {
          console.error(this.#logPrefix, 'Failed to deep clone for video-only clip, falling back to shallow clone', error);
        }
      }
      const videoOnlyOpts: MP4ClipOpts = {
        ...this.#opts,
        audio: false,
        decoderConfig: {
          video: this.#decoderConfig.video,
          audio: null,
        },
      };
      const videoClip = new MP4Clip(
        {
          localFile: fileForVideoClip,
          videoSamples: [...this.#videoSamples],
          audioSamples: [],
          parsedDecoderConfig: videoOnlyOpts.decoderConfig, // Use the specific config
          headerBoxPos: [...this.#headerBoxPos],
        },
        videoOnlyOpts,
      );
      clips.push(videoClip);
    }

    // If there are audio samples, create an audio-only clip
    if (this.#audioSamples.length > 0) {
      let fileForAudioClip = this.#localFile;
      // If we already cloned for video, and we need to clone for audio,
      // we should clone the *original* file again, not the (potentially) already cloned fileForVideoClip.
      if (this.#opts.deepClone) {
        try {
          console.info(this.#logPrefix, 'Deep cloning file for audio-only clip in splitTrack()');
          fileForAudioClip = await this.#copyLocalFile(this.#localFile);
        } catch (error) {
          console.error(this.#logPrefix, 'Failed to deep clone for audio-only clip, falling back to shallow clone', error);
        }
      }
      const audioOnlyOpts: MP4ClipOpts = {
        ...this.#opts,
        // audio: true, // audio should be true by default if decoderConfig.audio is present
        decoderConfig: {
          audio: this.#decoderConfig.audio,
          video: null,
        },
      };
      const audioClip = new MP4Clip(
        {
          localFile: fileForAudioClip,
          videoSamples: [],
          audioSamples: [...this.#audioSamples],
          parsedDecoderConfig: audioOnlyOpts.decoderConfig, // Use the specific config
          headerBoxPos: [...this.#headerBoxPos],
        },
        audioOnlyOpts,
      );
      clips.push(audioClip);
    }

    // Wait for all created clips to be ready
    await Promise.all(clips.map(clip => clip.ready));
    // Copy tickInterceptor after they are ready
    for (const clip of clips) {
      (clip as MP4Clip).tickInterceptor = this.tickInterceptor;
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

  async #copyLocalFile(originalFile: OPFSToolFile): Promise<OPFSToolFile> {
    const newFile = tmpfile();
    // Copy content from originalFile to newFile
    // Assuming OPFSToolFile has a way to get its full content as a stream or ArrayBuffer
    // and `write` can handle it.
    // If originalFile.stream() is available and write supports it:
    try {
      await write(newFile, await originalFile.stream());
    } catch (error) {
      console.error(this.#logPrefix, 'Error copying OPFS file for deep clone:', error);
      // Depending on error handling strategy, might want to clean up newFile
      // or rethrow, or return originalFile as a fallback (though that violates deepClone intent)
      throw error; // Rethrow for now, caller should handle cleanup or decide fallback
    }
    return newFile;
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
  decoderConfig: { video: VideoDecoderConfig | null; audio: AudioDecoderConfig | null },
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
// TODO-REFACTOR: `genDecoder` is a factory for VideoFrameFinder and AudioFrameFinder.
// The parameters (localFileReader, samples, config, logPrefix) are common.
// Consider if the finders could share more logic or if their construction could be less verbose.
function genDecoder(
  decoderConfig: { video: VideoDecoderConfig | null; audio: AudioDecoderConfig | null },
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
        : new AudioFrameFinder({
            localFileReader,
            samples: audioSamples,
            config: decoderConfig.audio,
            outputOpts: {
              volume,
              targetSampleRate: DEFAULT_AUDIO_CONF.sampleRate,
            },
            logPrefix,
          }),
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
 * @returns A Promise that resolves with an object containing videoSamples, audioSamples, parsedDecoderConfig, and headerBoxPos.
 * @throws Error if the stream parsing completes but no metadata (mp4Info) is emitted, or if no samples are found.
 */

async function _parseMP4File(
  opfsToolsFile: OPFSToolFile,
  logPrefix: string,
): Promise<{
  mp4Info: MP4Info; // Ensure this is not duplicated
  rawVideoSamples: MP4Sample[]; // Ensure this is not duplicated
  rawAudioSamples: MP4Sample[];
  parsedDecoderConfig: { video: VideoDecoderConfig | null; audio: AudioDecoderConfig | null };
  headerBoxPos: Array<{ start: number; size: number }>;
}> {
  const reader = await opfsToolsFile.createReader();
  // Call the new promise-based quickParseMP4File
  const { mp4Info, rawVideoSamples, rawAudioSamples, mp4boxFile } = await quickParseMP4File(reader);
  await reader.close();

  if (rawVideoSamples.length === 0 && rawAudioSamples.length === 0) {
    throw Error(`${logPrefix} MP4Clip stream not contain any sample`);
  }

  // Derive headerBoxPos
  const headerBoxPos: Array<{ start: number; size: number }> = [];
  if (mp4boxFile.ftyp != null) {
    headerBoxPos.push({ start: mp4boxFile.ftyp.start, size: mp4boxFile.ftyp.size });
  }
  if (mp4boxFile.moov != null) {
    headerBoxPos.push({ start: mp4boxFile.moov.start, size: mp4boxFile.moov.size });
  } else {
    // This case should ideally be caught by quickParseMP4File if moov is essential
    throw Error(`${logPrefix} MP4Clip stream is done, but moov box was not found.`);
  }

  // Derive parsedDecoderConfig
  const { videoDecoderConf, audioDecoderConf } = extractFileConfig(mp4boxFile, mp4Info);
  const parsedDecoderConfig: { video: VideoDecoderConfig | null; audio: AudioDecoderConfig | null } = {
    video: videoDecoderConf ?? null,
    audio: audioDecoderConf ?? null,
  };

  if (videoDecoderConf == null && audioDecoderConf == null) {
    console.error(logPrefix, 'MP4Clip no video and audio track');
  }
  console.info(
    logPrefix,
    'mp4BoxFile moov ready',
    // Avoid logging verbose track data
    { ...mp4Info, tracks: null, videoTracks: null, audioTracks: null },
    parsedDecoderConfig,
  );

  return {
    mp4Info, // Return the mp4Info obtained from quickParseMP4File
    rawVideoSamples,
    rawAudioSamples,
    parsedDecoderConfig,
    headerBoxPos,
  };
}

function _normalizeSamples(
  rawSamples: MP4Sample[],
  sampleType: 'video' | 'audio',
  deltaTS: number,
  logPrefix: string,
): ExtMP4Sample[] {

  function normalizeTimescaleHelper(
    sample: MP4Sample,
    delta: number,
  ): ExtMP4Sample {
    let dataOffset = sample.offset;
    let dataSize = sample.size;
    let is_idr = sample.is_sync; // Default to sample.is_sync

    if (sampleType === 'video') {
      const naluInfo = _getVideoSampleNALUInfo(sample);
      if (naluInfo.offset > 0) { // findIDRNALUOffset returns positive offset if found, or -1 (handled in _getVideoSampleNALUInfo to return 0)
        dataOffset += naluInfo.offset;
        dataSize -= naluInfo.offset;
      }
      is_idr = naluInfo.is_idr;
    }

    return {
      ...sample,
      is_idr, // Use NALU-derived IDR status
      offset: dataOffset,
      size: dataSize,
      cts: ((sample.cts - delta) / sample.timescale) * 1e6,
      dts: ((sample.dts - delta) / sample.timescale) * 1e6,
      duration: (sample.duration / sample.timescale) * 1e6,
      timescale: 1e6,
      data: sampleType === 'video' ? null : sample.data,
    };
  }

  const normalizedSamples: ExtMP4Sample[] = [];
  for (const sample of rawSamples) {
    normalizedSamples.push(normalizeTimescaleHelper(sample, deltaTS));
  }
  return normalizedSamples;
}

async function mp4FileToSamples(
  opfsToolsFile: OPFSToolFile,
  opts: MP4ClipOpts = {},
  logPrefix: string,
) {
  const {
    rawVideoSamples,
    rawAudioSamples,
    parsedDecoderConfig,
    headerBoxPos,
    // mp4Info is also returned but not directly used in the final output structure of this function
  } = await _parseMP4File(opfsToolsFile, logPrefix);

  let videoSamples: ExtMP4Sample[] = [];
  let audioSamples: ExtMP4Sample[] = [];

  if (rawVideoSamples.length > 0) {
    const videoDeltaTS = rawVideoSamples[0].dts;
    videoSamples = _normalizeSamples(rawVideoSamples, 'video', videoDeltaTS, logPrefix);
    fixFirstBlackFrame(videoSamples, logPrefix);
  }

  if (opts.audio && rawAudioSamples.length > 0) {
    const audioDeltaTS = rawAudioSamples[0].dts;
    audioSamples = _normalizeSamples(rawAudioSamples, 'audio', audioDeltaTS, logPrefix);
  }

  console.info(logPrefix, 'mp4 stream parsed and samples normalized');
  return {
    videoSamples,
    audioSamples,
    parsedDecoderConfig: parsedDecoderConfig,
    headerBoxPos,
  };
}

// This new function centralizes NALU parsing logic for video samples.
function _getVideoSampleNALUInfo(sample: MP4Sample): { offset: number; is_idr: boolean } {
  if (!sample.is_sync) {
    // Only sync samples (potential keyframes) are considered for NALU offset adjustments.
    // Non-sync samples are part of a GoP and don't start with SPS/PPS/IDR in the same way.
    return { offset: 0, is_idr: false };
  }

  switch (sample.description.type) {
    case 'avc1': // H.264
    case 'hvc1': { // H.265
      // findIDRNALUOffset expects the raw data buffer.
      // sample.data might be null if it's video and not loaded yet.
      // However, for normalization, sample.data IS available for AVC/HVC from mp4box.js if needed for this check.
      // The current structure of ExtMP4Sample sets video data to null *after* normalization.
      // Let's assume sample.data is available here as MP4Sample from mp4box.js.
      if (sample.data == null) {
        // This case should ideally not happen if we are to inspect NALUs.
        // If it does, we can't do NALU parsing, so fall back.
        console.warn('Attempted NALU parsing on sample with no data.');
        return { offset: 0, is_idr: sample.is_sync };
      }
      const naluScanResult = findIDRNALUOffset(sample.data, sample.description.type);
      if (naluScanResult.offset >= 0) {
        // An IDR NALU was found, and its offset within the sample data is naluScanResult.offset.
        // This offset is the amount to skip from the beginning of the sample's data.
        return { offset: naluScanResult.offset, is_idr: true };
      } else {
        // No specific IDR NALU found by scanning (e.g., it's the first NALU, or not an IDR).
        // Rely on the container's sync flag, and no data offset adjustment.
        return { offset: 0, is_idr: sample.is_sync };
      }
    }
    // Potentially add cases for other codecs like 'vp09', 'av01' if they have similar NALU structures
    // or require specific leading bytes to be skipped.
    default:
      // For other video codecs or if NALU parsing is not implemented,
      // use the sample's sync flag and assume no offset.
      return { offset: 0, is_idr: sample.is_sync };
  }
}

/**
 * Manages video frame decoding and retrieval.
 * It efficiently seeks to the requested time, decodes a Group of Pictures (GoP),
 * and provides the target VideoFrame.
 */
// TODO-REFACTOR: The state management in VideoFrameFinder (e.g., #currentTimestamp, #isDecodingInProgress, #useSoftwareDecoding)
// could be encapsulated into a more formal state machine pattern to handle transitions between states like
// 'idle', 'decoding', 'seeking', 'error', 'softwareFallback' more robustly.
// TODO-REFACTOR: Error handling in `VideoFrameFinder` (e.g., in `#reset` or `#startDecode`) could be more structured.
// For instance, defining specific error types or using a retry policy for certain recoverable errors.
// TODO-REFACTOR: The constructor of `VideoFrameFinder` takes multiple individual parameters.
// Consider using a single options object for better readability and extensibility if more params are added.
// VideoFrameFinder class and related definitions removed.
// These will be imported from ./video-frame-finder.ts

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
// TODO-REFACTOR: Similar to VideoFrameFinder, `AudioFrameFinder` state management (`#currentTimestamp`, `#decodeCursorIndex`)
// could be more formalized. Error handling and constructor parameters also follow similar patterns
// and could benefit from the same refactoring considerations (state machine, structured errors, options object).
// IAudioFrameFinderOpts and AudioFrameFinderState removed.

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
// Note: SampleReadError could be generic if audio samples were read from file like video,
// AudioFrameFinder class and related definitions removed.

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

// 并行执行任务，但按顺序emit结果
// REFACTOR-IDEA: `createPromiseQueue` is a generic utility. If used elsewhere,
// it could be moved to a more general utility module.
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
  // todo: perf 重复利用内存空间
  // REFACTOR-IDEA: The `emitAudioFrames` function creates new Float32Arrays for output.
  // For performance-critical applications, consider a pool of reusable buffers or allowing
  // the caller to provide output buffers to minimize allocations and garbage collection.
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