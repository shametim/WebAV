import { MP4Sample } from '@webav/mp4box.js';
import { file } from 'opfs-tools'; // For OPFSToolFile type derivation

// Type alias for the file object returned by opfs-tools' file() function
// This is defined in mp4-clip.ts as well, ensure consistency or centralize.
// For now, let's assume OPFSToolFile might be needed here or defined more globally.
// If LocalFileReader is just about the Awaited type, it might not need the full OPFSToolFile here.
type OPFSToolFile = ReturnType<typeof file>;

// Extended MP4Sample type, omitting the original 'data' and adding specific properties
export type ExtMP4Sample = Omit<MP4Sample, 'data'> & {
  is_idr: boolean; // Indicates if the sample is an Instantaneous Decoder Refresh (IDR) frame
  deleted?: boolean; // Flag to mark a sample as deleted (e.g., after splitting)
  data: null | Uint8Array; // Raw sample data (null for video to be loaded on demand, Uint8Array for audio)
};

// Type alias for the file reader created from an OPFSToolFile
export type LocalFileReader = Awaited<ReturnType<OPFSToolFile['createReader']>>;

/**
 * Retrieves browser memory usage information if available via `performance.memory`.
 * @returns An object with memory usage details, or an empty object if API is not available.
 */
export function memoryUsageInfo(): object {
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
