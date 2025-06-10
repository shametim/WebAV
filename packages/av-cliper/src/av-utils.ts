// Utility functions that can run in both worker and main thread environments.

import { workerTimer } from '@webav/internal-utils';
import * as waveResampler from 'wave-resampler';

/**
 * Concatenates multiple Float32Array instances.
 * This is commonly used for merging PCM audio data segments.
 *
 * @param buffers - An array of Float32Array instances to be concatenated.
 * @returns A new Float32Array containing all the elements from the input arrays, in order.
 */
export function concatFloat32Array(buffers: Float32Array[]): Float32Array {
  // Calculate the total length of the resulting array.
  const totalLength = buffers
    .map((buf) => buf.length)
    .reduce((a, b) => a + b, 0);
  const resultArray = new Float32Array(totalLength);

  let offset = 0;
  // Iterate over each buffer and set its contents in the result array.
  for (const buffer of buffers) {
    resultArray.set(buffer, offset);
    offset += buffer.length;
  }

  return resultArray;
}

/**
 * Merges small PCM fragments into a larger segment.
 *
 * @param fragments - An array of PCM fragments. Each fragment is an array of Float32Arrays,
 *                    where each Float32Array represents the raw PCM data for a different channel.
 *                    Example: [[channel0Data, channel1Data], [channel0Data, channel1Data], ...]
 * @returns An array of Float32Arrays, where each Float32Array is a large segment of PCM data for a single channel.
 *          Example: [bigChannel0Data, bigChannel1Data]
 */
export function concatPCMFragments(
  fragments: Float32Array[][],
): Float32Array[] {
  // fragments: [[chan0, chan1], [chan0, chan1]...]
  // channelSeparatedPCM: [[chan0, chan0...], [chan1, chan1...]]
  const channelSeparatedPCM: Float32Array[][] = [];
  for (let i = 0; i < fragments.length; i += 1) {
    for (let j = 0; j < fragments[i].length; j += 1) {
      // Initialize an array for the channel if it doesn't exist.
      if (channelSeparatedPCM[j] == null) channelSeparatedPCM[j] = [];
      channelSeparatedPCM[j].push(fragments[i][j]);
    }
  }
  // Concatenate PCM data for each channel.
  // Result: [bigChannel0, bigChannel1]
  return channelSeparatedPCM.map(concatFloat32Array);
}

/**
 * Utility function to extract PCM data from an AudioData object.
 *
 * @param audioData - The AudioData object from which to extract PCM data.
 * @returns An array of Float32Arrays, where each Float32Array contains the PCM data for one audio channel.
 * @throws Error if the audio data format is unsupported.
 */
export function extractPCM4AudioData(audioData: AudioData): Float32Array[] {
  // Handle 'f32-planar' format (Float32, separate planes for each channel).
  if (audioData.format === 'f32-planar') {
    const resultChannels = [];
    for (let idx = 0; idx < audioData.numberOfChannels; idx += 1) {
      const channelBufferSize = audioData.allocationSize({ planeIndex: idx });
      const channelBuffer = new ArrayBuffer(channelBufferSize);
      audioData.copyTo(channelBuffer, { planeIndex: idx });
      resultChannels.push(new Float32Array(channelBuffer));
    }
    return resultChannels;
  }
  // Handle 'f32' format (Float32, interleaved channels).
  else if (audioData.format === 'f32') {
    const interleavedBuffer = new ArrayBuffer(
      audioData.allocationSize({ planeIndex: 0 }),
    );
    audioData.copyTo(interleavedBuffer, { planeIndex: 0 });
    return convertF32ToPlanar(
      new Float32Array(interleavedBuffer),
      audioData.numberOfChannels,
    );
  }
  // Handle 's16' format (Signed 16-bit integer, interleaved channels).
  else if (audioData.format === 's16') {
    const interleavedS16Buffer = new ArrayBuffer(
      audioData.allocationSize({ planeIndex: 0 }),
    );
    audioData.copyTo(interleavedS16Buffer, { planeIndex: 0 });
    return convertS16ToF32Planar(
      new Int16Array(interleavedS16Buffer),
      audioData.numberOfChannels,
    );
  }
  // Throw an error for unsupported formats.
  throw Error('Unsupported audio data format');
}

/**
 * Converts s16 (signed 16-bit integer) PCM data to f32-planar (Float32, separate planes) format.
 *
 * @param pcmSigned16BitData - The Int16Array containing the s16 PCM data (interleaved).
 * @param numChannels - The number of audio channels.
 * @returns An array of Float32Arrays, each containing the audio data for one channel, normalized to the range [-1.0, 1.0].
 */
function convertS16ToF32Planar(
  pcmSigned16BitData: Int16Array,
  numChannels: number,
): Float32Array[] {
  const numSamples = pcmSigned16BitData.length / numChannels;
  const planarData = Array.from(
    { length: numChannels },
    () => new Float32Array(numSamples),
  );

  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = pcmSigned16BitData[i * numChannels + channel];
      // Normalize s16 data (range -32768 to 32767) to f32 data (range -1.0 to 1.0).
      planarData[channel][i] = sample / 32768;
    }
  }

  return planarData;
}

/**
 * Converts f32 (Float32, interleaved) PCM data to f32-planar (Float32, separate planes) format.
 *
 * @param pcmF32Data - The Float32Array containing the f32 PCM data (interleaved).
 * @param numChannels - The number of audio channels.
 * @returns An array of Float32Arrays, each containing the audio data for one channel.
 */
function convertF32ToPlanar(
  pcmF32Data: Float32Array,
  numChannels: number,
): Float32Array[] {
  const numSamples = pcmF32Data.length / numChannels;
  const planarData = Array.from(
    { length: numChannels },
    () => new Float32Array(numSamples),
  );

  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      planarData[channel][i] = pcmF32Data[i * numChannels + channel];
    }
  }

  return planarData;
}

/**
 * Extracts PCM data from an AudioBuffer.
 *
 * @param audioBuffer - The AudioBuffer from which to extract PCM data.
 * @returns An array of Float32Arrays, where each Float32Array contains the PCM data for one audio channel.
 */
export function extractPCM4AudioBuffer(
  audioBuffer: AudioBuffer,
): Float32Array[] {
  // Create an array with the length of numberOfChannels and map over it.
  return Array(audioBuffer.numberOfChannels)
    .fill(0)
    .map((_, channelIndex) => {
      // For each channel index, get the channel data.
      return audioBuffer.getChannelData(channelIndex);
    });
}

/**
 * Adjusts the volume of audio data.
 *
 * @param audioData - The AudioData object to be adjusted.
 * @param volume - The volume adjustment factor (0.0 to 1.0, where 1.0 is original volume).
 * @returns A new AudioData object with the adjusted volume. The original AudioData object is closed.
 */
export function adjustAudioDataVolume(
  audioData: AudioData,
  volume: number,
): AudioData {
  // Extract PCM data, apply volume adjustment, and create a new Float32Array.
  const adjustedPCMData = new Float32Array(
    concatFloat32Array(extractPCM4AudioData(audioData)),
  ).map((sampleValue) => sampleValue * volume);

  // Create a new AudioData object with the adjusted PCM data and original metadata.
  const newAudioData = new AudioData({
    sampleRate: audioData.sampleRate,
    numberOfChannels: audioData.numberOfChannels,
    timestamp: audioData.timestamp,
    format: audioData.format!, // Assert non-null as it's required for creating AudioData
    numberOfFrames: audioData.numberOfFrames,
    data: adjustedPCMData,
  });

  // Close the original AudioData object to free up resources.
  audioData.close();
  return newAudioData;
}

/**
 * Decodes an image stream and returns an array of video frames.
 * This is useful for handling animated images like GIFs.
 *
 * @param stream - A ReadableStream containing the image data (e.g., from a fetch response).
 * @param type - The MIME type of the image (e.g., 'image/gif', 'image/jpeg').
 * @returns A Promise that resolves to an array of {@link VideoFrame} objects.
 *
 * @see [Decode animated images (Demo)](https://webav-tech.github.io/WebAV/demo/1_3-decode-image)
 *
 * @example
 * // Decoding a GIF from a URL
 * const response = await fetch('<gif_url>');
 * const frames = await decodeImg(response.body!, 'image/gif');
 */
export async function decodeImg(
  stream: ReadableStream<Uint8Array>,
  type: string,
): Promise<VideoFrame[]> {
  // Initialization options for ImageDecoder.
  const init = {
    type, // MIME type of the image.
    data: stream, // The readable stream of image data.
  };
  const imageDecoder = new ImageDecoder(init);

  // Wait for the decoder to complete metadata parsing and for tracks to be ready.
  await Promise.all([imageDecoder.completed, imageDecoder.tracks.ready]);

  // Get the frame count from the selected track (if available), default to 1 for static images.
  let frameCount = imageDecoder.tracks.selectedTrack?.frameCount ?? 1;

  const videoFrames: VideoFrame[] = [];
  // Decode each frame.
  for (let i = 0; i < frameCount; i += 1) {
    // Decode the frame at the current index and push the resulting image (VideoFrame) to the array.
    videoFrames.push((await imageDecoder.decode({ frameIndex: i })).image);
  }
  return videoFrames;
}

/**
 * Mixes PCM data from multiple stereo audio tracks into a single Float32Array.
 * The output Float32Array will have left and right channel data interleaved if multiple channels exist,
 * or duplicated if only mono sources are provided.
 *
 * @param audios - A 2D array where each inner array represents an audio stream's PCM data.
 *                 Each inner array should contain one Float32Array for mono (left channel)
 *                 or two Float32Arrays for stereo (left channel, then right channel).
 *                 If only left channel data is provided for a track, it will be duplicated for the right channel.
 * @returns A Float32Array containing the mixed audio data. Left channel data comes first, followed by right channel data.
 *          For example, if maxLen is the length of the longest channel, the output will be
 *          [L0, L1, ..., LmaxLen-1, R0, R1, ..., RmaxLen-1].
 *
 * @example
 * const audios = [
 *   // Track 1: Stereo
 *   [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])],
 *   // Track 2: Mono (will be duplicated for right channel)
 *   [new Float32Array([0.7, 0.8, 0.9])],
 * ];
 * const mixed = mixinPCM(audios);
 * // `mixed` will contain interleaved L and R channel data after mixing.
 */
export function mixinPCM(audios: Float32Array[][]): Float32Array {
  // Determine the maximum length among all first channels (left channels) of the audio tracks.
  const maxLen = Math.max(
    ...audios.map((audioTrack) => audioTrack[0]?.length ?? 0),
  );
  // Create a Float32Array to hold the mixed data. Size is maxLen * 2 for stereo (L and R channels).
  const mixedData = new Float32Array(maxLen * 2);

  // Iterate up to the maximum length found.
  for (let sampleIndex = 0; sampleIndex < maxLen; sampleIndex++) {
    let mixedChannel0Sample = 0; // Sum of samples for channel 0 (left) at current sampleIndex
    let mixedChannel1Sample = 0; // Sum of samples for channel 1 (right) at current sampleIndex

    // Iterate over each audio track.
    for (let trackIndex = 0; trackIndex < audios.length; trackIndex++) {
      // Get sample from channel 0 (left) of the current track, or 0 if it doesn't exist at this sampleIndex.
      const trackChannel0Sample = audios[trackIndex][0]?.[sampleIndex] ?? 0;
      // Get sample from channel 1 (right) of the current track.
      // If channel 1 doesn't exist or the sample is undefined, duplicate channel 0's sample.
      const trackChannel1Sample =
        audios[trackIndex][1]?.[sampleIndex] ?? trackChannel0Sample;

      mixedChannel0Sample += trackChannel0Sample;
      mixedChannel1Sample += trackChannel1Sample;
    }
    // Store the mixed left channel sample.
    mixedData[sampleIndex] = mixedChannel0Sample;
    // Store the mixed right channel sample in the second half of the array.
    mixedData[sampleIndex + maxLen] = mixedChannel1Sample;
  }

  return mixedData;
}

/**
 * Resamples PCM audio data to a target sample rate and channel count.
 *
 * @param pcmData - An array of Float32Arrays, where each Float32Array represents PCM data for one channel.
 * @param currentRate - The current sample rate of the input PCM data.
 * @param target - An object specifying the target parameters:
 * @param target.rate - The target sample rate.
 * @param target.chanCount - The target number of channels.
 * @returns A Promise that resolves to an array of Float32Arrays, each representing resampled PCM data for one channel.
 *
 * @example
 * const pcmData = [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.4, 0.5, 0.6])];
 * const currentRate = 44100;
 * const target = { rate: 48000, chanCount: 2 };
 * const resampled = await audioResample(pcmData, currentRate, target);
 */
export async function audioResample(
  pcmData: Float32Array[],
  currentRate: number,
  target: {
    rate: number;
    chanCount: number;
  },
): Promise<Float32Array[]> {
  const channelCount = pcmData.length;
  // Prepare an empty PCM array for the target channel count, in case of empty input.
  const emptyPCMResult = Array(target.chanCount)
    .fill(0)
    .map(() => new Float32Array(0));

  if (channelCount === 0) return emptyPCMResult;

  // Find the maximum length of the input PCM data channels.
  const maxLength = Math.max(...pcmData.map((channel) => channel.length));
  if (maxLength === 0) return emptyPCMResult;

  // If OfflineAudioContext is not available (e.g., in a Worker without full browser APIs),
  // use wave-resampler library as a fallback.
  if (globalThis.OfflineAudioContext == null) {
    return pcmData.map(
      (pcmChannelData) =>
        new Float32Array(
          waveResampler.resample(pcmChannelData, currentRate, target.rate, {
            method: 'sinc', // Use sinc interpolation method.
            LPF: false, // Disable Low Pass Filter.
          }),
        ),
    );
  }

  // Use OfflineAudioContext for high-quality resampling when available.
  const offlineCtx = new globalThis.OfflineAudioContext(
    target.chanCount,
    (maxLength * target.rate) / currentRate, // Calculate the duration in samples at the target rate.
    target.rate,
  );
  const audioBufferSource = offlineCtx.createBufferSource();
  // Create an AudioBuffer with the original channel count, length, and sample rate.
  const audioBuffer = offlineCtx.createBuffer(
    channelCount,
    maxLength,
    currentRate,
  );
  // Copy PCM data from input arrays to the channels of the AudioBuffer.
  pcmData.forEach((data, index) => audioBuffer.copyToChannel(data, index));

  audioBufferSource.buffer = audioBuffer;
  audioBufferSource.connect(offlineCtx.destination);
  audioBufferSource.start();

  // Start rendering and extract PCM data from the resulting AudioBuffer.
  return extractPCM4AudioBuffer(await offlineCtx.startRendering());
}

/**
 * Pauses the current execution environment for a specified duration.
 *
 * @param time - The duration to pause, in milliseconds.
 * @returns A Promise that resolves after the specified time has elapsed.
 * @example
 * console.log('Start');
 * await sleep(1000); // Pauses for 1 second
 * console.log('End');
 */
export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => {
    // Use workerTimer to ensure the timer works reliably even in background tabs.
    const stopTimer = workerTimer(() => {
      stopTimer(); // Stop the timer itself.
      resolve(); // Resolve the promise.
    }, time);
  });
}

/**
 * Extracts a circular slice from a Float32Array. If the slice extends beyond
 * the array boundaries, it wraps around to the beginning of the array.
 * This is primarily used for creating looping PCM audio segments.
 *
 * @param data - The input Float32Array.
 * @param start - The starting index for the slice.
 * @param end - The ending index (exclusive) for the slice.
 * @returns A new Float32Array containing the circular slice.
 *
 * @example
 * const data = new Float32Array([0, 1, 2, 3, 4, 5]);
 * // Slices from index 4 to 6 (exclusive), wrapping around.
 * ringSliceFloat32Array(data, 4, 7); // Results in Float32Array [4, 5, 0] (length 3: 7-4)
 * ringSliceFloat32Array(data, 1, 4); // Results in Float32Array [1, 2, 3] (length 3: 4-1)
 */
export function ringSliceFloat32Array(
  data: Float32Array,
  start: number,
  end: number,
): Float32Array {
  const count = end - start;
  const resultArray = new Float32Array(count);
  let i = 0;
  while (i < count) {
    // Use the modulo operator to wrap around the array.
    resultArray[i] = data[(start + i) % data.length];
    i += 1;
  }
  return resultArray;
}

/**
 * Changes the playback rate of PCM data.
 * A playbackRate of 1 means normal speed, 0.5 means half speed, and 2 means double speed.
 * This function uses linear interpolation for resampling.
 *
 * @param pcmData - The input Float32Array containing the PCM data (single channel).
 * @param playbackRate - The desired playback rate.
 * @returns A new Float32Array with the adjusted playback rate.
 */
export function changePCMPlaybackRate(
  pcmData: Float32Array,
  playbackRate: number,
): Float32Array {
  // Calculate the new length of the PCM data based on the playback rate.
  const newLength = Math.floor(pcmData.length / playbackRate);
  const newPcmData = new Float32Array(newLength);

  // Perform linear interpolation to create the new PCM data.
  for (let i = 0; i < newLength; i++) {
    // Calculate the corresponding index in the original data.
    const originalIndex = i * playbackRate;
    const integerIndex = Math.floor(originalIndex);
    const fractionalPart = originalIndex - integerIndex;

    // Boundary check: ensure we don't read beyond the original array's bounds.
    if (integerIndex + 1 < pcmData.length) {
      // Linear interpolation: new_sample = sample1 * (1 - fraction) + sample2 * fraction
      newPcmData[i] =
        pcmData[integerIndex] * (1 - fractionalPart) +
        pcmData[integerIndex + 1] * fractionalPart;
    } else {
      // If at the end, just use the last available sample.
      newPcmData[i] = pcmData[integerIndex];
    }
  }

  return newPcmData;
}
