import mp4box, {
  AudioTrackOpts,
  ESDSBoxParser,
  MP4ABoxParser,
  MP4ArrayBuffer,
  MP4File,
  MP4Info,
  MP4Sample,
  TrakBoxParser,
  VideoTrackOpts,
} from '@webav/mp4box.js';
import { DEFAULT_AUDIO_CONF } from '../clips';
import { file } from 'opfs-tools';

/**
 * Extracts the necessary configuration objects for WebCodecs decoders
 * from a parsed MP4 file. This function translates the MP4 metadata
 * into a format that VideoDecoder and AudioDecoder can understand.
 *
 * @param file - The parsed MP4File object from mp4box.js.
 * @param info - The info object provided by mp4box.js's onReady callback.
 * @returns An object containing track and decoder configurations for video and audio.
 */
export function extractFileConfig(file: MP4File, info: MP4Info) {
  // Get the first video track from the MP4 info.
  const vTrack = info.videoTracks[0];
  // TODO-REFACTOR: The variable name 'rs' is generic. Consider renaming to something more descriptive
  // like 'trackConfigsBundle' or 'mediaDecoderConfigs'.
  const rs: {
    videoTrackConf?: VideoTrackOpts;
    videoDecoderConf?: Parameters<VideoDecoder['configure']>[0];
    audioTrackConf?: AudioTrackOpts;
    audioDecoderConf?: Parameters<AudioDecoder['configure']>[0];
  } = {};

  // REFACTOR-IDEA: The logic for video and audio track processing is similar in structure.
  // If support for more track types (e.g., subtitles, metadata) were to be added in the future,
  // consider abstracting the common parts of track processing into a generic function
  // or using a strategy pattern to handle different track types more uniformly.
  if (vTrack != null) {
    // The 'description' for the VideoDecoder is a binary blob (avcC, hvcC, etc.)
    // that contains essential initialization parameters for the codec.
    const videoDesc = parseVideoCodecDesc(file.getTrackById(vTrack.id)).buffer;

    // Determine the key for the decoder configuration record based on the codec string.
    // TODO-REFACTOR: The codec-specific key determination (avcDecoderConfigRecord vs. hevcDecoderConfigRecord)
    // could be made more extensible, perhaps using a map or a more dynamic approach if more codecs
    // requiring specific description keys are added.
    const { descKey, type } = vTrack.codec.startsWith('avc1') // H.264/AVC
      ? { descKey: 'avcDecoderConfigRecord', type: 'avc1' }
      : vTrack.codec.startsWith('hvc1') // H.265/HEVC
        ? { descKey: 'hevcDecoderConfigRecord', type: 'hvc1' }
        : { descKey: '', type: '' }; // Other codecs might not need this.

    // If we identified a known codec type, create the configuration for it.
    if (descKey !== '') {
      // This configuration is useful if you need to remux the MP4 file.
      rs.videoTrackConf = {
        timescale: vTrack.timescale,
        duration: vTrack.duration,
        width: vTrack.video.width,
        height: vTrack.video.height,
        brands: info.brands,
        type,
        // Dynamically set the key for the decoder config record.
        [descKey]: videoDesc,
      };
    }

    // This is the configuration object required by the WebCodecs VideoDecoder.
    rs.videoDecoderConf = {
      codec: vTrack.codec,
      codedHeight: vTrack.video.height,
      codedWidth: vTrack.video.width,
      description: videoDesc, // The critical binary blob for decoder initialization.
    };
  }

  // Get the first audio track from the MP4 info.
  const aTrack = info.audioTracks[0];
  if (aTrack != null) {
    // The 'esds' box contains detailed configuration for AAC audio.
    const esdsBox = getESDSBoxFromMP4File(file);

    // This configuration is for remuxing purposes.
    rs.audioTrackConf = {
      timescale: aTrack.timescale,
      samplerate: aTrack.audio.sample_rate,
      channel_count: aTrack.audio.channel_count,
      hdlr: 'soun', // Handler type for sound tracks.
      type: aTrack.codec.startsWith('mp4a') ? 'mp4a' : aTrack.codec,
      description: getESDSBoxFromMP4File(file),
    };

    // This is the configuration object for the WebCodecs AudioDecoder.
    rs.audioDecoderConf = {
      // Sometimes the codec string is 'mp4a.40.2'; we standardize it for wider compatibility.
      codec: aTrack.codec.startsWith('mp4a')
        ? DEFAULT_AUDIO_CONF.codec // e.g., 'mp4a.40.2'
        : aTrack.codec,
      numberOfChannels: aTrack.audio.channel_count,
      sampleRate: aTrack.audio.sample_rate,
      // If the 'esds' box is present, parse it to get the most accurate
      // audio info, as it can correct errors in the higher-level metadata.
      ...(esdsBox == null ? {} : parseAudioInfo4ESDSBox(esdsBox)),
    };
  }
  return rs;
}

/**
 * A helper function to parse the video codec's specific description box
 * (e.g., avcC for H.264, hvcC for H.265) from a track.
 * This binary data is essential for initializing the video decoder.
 *
 * @param track - The track object from mp4box.js.
 * @returns A Uint8Array containing the raw codec description data.
 */
function parseVideoCodecDesc(track: TrakBoxParser): Uint8Array {
  // The description box is located inside the sample description ('stsd') box.
  for (const entry of track.mdia.minf.stbl.stsd.entries) {
    // The box can have different names depending on the codec (avcC, hvcC, etc.).
    // TODO-REFACTOR: The use of `@ts-expect-error` suggests that the mp4box.js types might not fully
    // cover all possible codec-specific entry types (like av1C, vpcC), or there's a need to access
    // properties in a way not strictly defined by the current union type.
    // This could be improved by:
    // 1. Extending or refining mp4box.js type definitions if possible.
    // 2. Using type assertions with caution if the structure is known and stable.
    // 3. Adding a more robust type check or property existence check before access.
    // @ts-expect-error - Accessing non-standard properties on a union type.
    const box = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC;
    if (box != null) {
      const stream = new mp4box.DataStream(
        undefined,
        0,
        mp4box.DataStream.BIG_ENDIAN,
      );
      // Write the box's contents to a new stream to serialize it.
      box.write(stream);
      // Return the buffer, slicing off the first 8 bytes (the box header: size and type).
      return new Uint8Array(stream.buffer.slice(8));
    }
  }
  throw Error('Codec description box (avcC, hvcC, av1C, or vpcC) not found');
}

/**
 * A helper function to find the 'esds' (Elementary Stream Descriptor) box,
 * which contains detailed configuration for AAC audio.
 *
 * @param file - The parsed MP4File object.
 * @param codec - The codec type to look for, typically 'mp4a'.
 * @returns The 'esds' box parser object, or undefined if not found.
 */
function getESDSBoxFromMP4File(file: MP4File, codec = 'mp4a') {
  // Navigate through the MP4 structure to find the 'esds' box within an 'mp4a' entry.
  const mp4aBox = file.moov?.traks
    .map((t) => t.mdia.minf.stbl.stsd.entries)
    .flat()
    .find(({ type }) => type === codec) as MP4ABoxParser;

  return mp4aBox?.esds;
}

/**
 * Manually parses the 'esds' box to extract the true sample rate and channel count.
 * This is a workaround for mislabeled MP4 files where the top-level metadata is incorrect,
 * which would otherwise cause decoding to fail.
 *
 * @param esds - The 'esds' box parser object.
 * @returns An object with the correct sampleRate and numberOfChannels.
 */
// TODO-REFACTOR: `parseAudioInfo4ESDSBox` involves direct binary parsing of the ESDS box
// and uses a hardcoded `sampleRateEnum`. This is specific to AAC.
// If other audio codecs require similar deep parsing, this logic might need to be
// abstracted or handled by a more general-purpose ESDS parsing utility or per-codec handlers.
// The hardcoded `sampleRateEnum` could also be defined as a constant elsewhere if used more broadly.
function parseAudioInfo4ESDSBox(esds: ESDSBoxParser) {
  const decoderConf = esds.esd.descs[0]?.descs[0];
  if (decoderConf == null) return {};

  const [byte1, byte2] = decoderConf.data;
  // The sample rate index is encoded across two bytes.
  // It's the last 3 bits of the first byte and the first bit of the second byte.
  const sampleRateIdx = ((byte1 & 0x07) << 1) + (byte2 >> 7);
  // The channel count is the next 4 bits in the second byte.
  const numberOfChannels = (byte2 & 0x7f) >> 3;

  // The AAC specification defines a standard table for sample rates.
  const sampleRateEnum = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ] as const;

  // Return the parsed values, which will override the top-level metadata.
  return {
    sampleRate: sampleRateEnum[sampleRateIdx],
    numberOfChannels,
  };
}

/**
 * A fast, memory-efficient function to parse an MP4 file from a reader.
 * It reads the file in chunks, prioritizing the 'moov' atom (metadata)
 * and avoiding loading the entire 'mdat' atom (media data) into memory.
 *
 * @param reader - An OPFS file reader instance.
 * @param onReady - A callback that fires once the 'moov' atom is parsed and file info is available.
 * @param onSamples - A callback that fires as the sample index is parsed, providing chunks of samples.
 */
// REFACTOR-IDEA: `quickParseMP4File` uses callbacks (`onReady`, `onSamples`) for asynchronous operations.
// This could potentially be refactored to use Promises for a more modern async/await flow,
// perhaps by wrapping the mp4box.js event-driven API. This might make it easier to integrate
// into larger async workflows.
// TODO-REFACTOR: The `nbSamples` option in `setExtractionOptions` is hardcoded to 100.
// This value might not be optimal for all scenarios (e.g., very short clips or clips with
// very high sample rates). Consider making this configurable or dynamically adjusting it.
export async function quickParseMP4File(
  reader: Awaited<ReturnType<ReturnType<typeof file>['createReader']>>,
  onReady: (data: { mp4boxFile: MP4File; info: MP4Info }) => void,
  onSamples: (
    id: number,
    sampleType: 'video' | 'audio',
    samples: MP4Sample[],
  ) => void,
) {
  // Create a new mp4box file parser instance.
  const mp4boxFile = mp4box.createFile(false);

  // Set up the callback for when the file's metadata ('moov' box) is ready.
  mp4boxFile.onReady = (info) => {
    // Fire the user-provided onReady callback with the file info.
    onReady({ mp4boxFile, info });

    // After metadata is ready, tell mp4box to start extracting sample information.
    // This doesn't extract the actual data, just the metadata about each sample.
    const vTrackId = info.videoTracks[0]?.id;
    if (vTrackId != null)
      mp4boxFile.setExtractionOptions(vTrackId, 'video', { nbSamples: 100 });

    const aTrackId = info.audioTracks[0]?.id;
    if (aTrackId != null)
      mp4boxFile.setExtractionOptions(aTrackId, 'audio', { nbSamples: 100 });

    // Start the extraction process.
    mp4boxFile.start();
  };

  // Set up the callback for when sample information has been extracted.
  mp4boxFile.onSamples = onSamples;

  // Start the chunked parsing process.
  await parse();

  // This inner function performs the actual chunked reading and parsing loop.
  async function parse() {
    let cursor = 0; // The current position in the file.
    const maxReadSize = 30 * 1024 * 1024; // Read in 30 MB chunks.

    while (true) {
      // Read a chunk of data from the file at the current cursor position.
      const data = (await reader.read(maxReadSize, {
        at: cursor,
      })) as MP4ArrayBuffer;

      // If we've reached the end of the file, break the loop.
      if (data.byteLength === 0) break;

      // Tell mp4box where this chunk is located in the original file.
      // This is crucial for calculating the correct absolute byte offsets.
      data.fileStart = cursor;

      // Feed the chunk to the parser. mp4box processes it and returns the
      // position in the file where the next read should start.
      const nextPos = mp4boxFile.appendBuffer(data);

      // If nextPos is null, it means mp4box has found all the necessary
      // metadata ('moov') and doesn't need any more data. We can stop reading.
      if (nextPos == null) break;

      // Otherwise, update the cursor to the new position for the next loop iteration.
      cursor = nextPos;
    }

    // Inform mp4box that we have reached the end of the file stream.
    mp4boxFile.stop();
  }
}
```
