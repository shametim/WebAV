import { BaseSprite } from './base-sprite';
import { IClip } from '../clips';
import { changePCMPlaybackRate } from '../av-utils';

/**
 * @class OffscreenSprite
 * @extends BaseSprite
 *
 * OffscreenSprite wraps an {@link IClip} to extend it with properties like
 * coordinates (rect), layering (zIndex), opacity, and timing (offset, duration, playbackRate).
 * It is primarily designed for use with the {@link Combinator} for background video composition,
 * where rendering happens offscreen without a visible canvas element.
 *
 * This class is very similar to {@link VisibleSprite} but is used in different application scenarios,
 * specifically for non-DOM-attached, offscreen rendering tasks.
 *
 * @example
 * // Create a sprite from an MP4Clip
 * const mp4Clip = new MP4Clip((await fetch('<mp4_url>')).body);
 * const sprite = new OffscreenSprite(mp4Clip);
 *
 * // Wait for the sprite (and underlying clip) to be ready
 * await sprite.ready;
 *
 * // Set sprite properties
 * sprite.opacity = 0.5; // Make the sprite semi-transparent
 * sprite.rect.x = 100;  // Offset the sprite 100 pixels on the x-axis
 * sprite.time.offset = 10e6; // Start rendering this clip 10 seconds into the combination
 *
 * @see {@link Combinator} - For combining multiple sprites and clips.
 * @see [Video Combination Demo](https://webav-tech.github.io/WebAV/demo/2_1-concat-video) - Demonstrates usage.
 */
export class OffscreenSprite extends BaseSprite {
  #clip: IClip;

  // Stores the most recent video frame. If the clip has no data at the current frame,
  // this last frame is drawn instead to avoid gaps.
  #lastVf: VideoFrame | ImageBitmap | null = null;

  #destroyed = false;

  // Static counter to generate unique IDs for sprite instances for logging.
  static #spriteIdCounter = 0;
  // Instance-specific ID for logging.
  #spriteId = OffscreenSprite.#spriteIdCounter++;
  // Prefix for console logging, includes instance ID for easier debugging.
  #logPrefix: string;

  /**
   * Creates an instance of OffscreenSprite.
   * @param {IClip} clip - The underlying clip (e.g., MP4Clip, ImgClip) that this sprite will manage and render.
   */
  constructor(clip: IClip) {
    super();
    this.#clip = clip;
    this.#logPrefix = `OffscreenSprite id:${this.#spriteId}:`;

    // The sprite's ready promise depends on the underlying clip's readiness.
    // Once the clip is ready, the sprite's dimensions and duration are initialized
    // if they haven't been set explicitly.
    this.ready = clip.ready.then(({ width, height, duration }) => {
      // Default sprite width to clip width if not already set.
      this.rect.w = this.rect.w === 0 ? width : this.rect.w;
      // Default sprite height to clip height if not already set.
      this.rect.h = this.rect.h === 0 ? height : this.rect.h;
      // Default sprite duration to clip duration if not already set.
      this.time.duration =
        this.time.duration === 0 ? duration : this.time.duration;
    });
  }

  /**
   * Renders the sprite's visual content for a given time onto a 2D rendering context
   * and extracts the corresponding audio data.
   * This method handles time adjustments for playback rate, animation updates,
   * and rendering of the video frame (or the last available frame).
   *
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx - The 2D rendering context to draw on.
   * @param {number} time - The current time in the combination/timeline, in microseconds.
   *                        This time is relative to the parent Combinator's timeline.
   * @returns {Promise<{ audio: Float32Array[]; done: boolean }>} A promise that resolves to an object containing:
   *   - `audio`: An array of Float32Arrays, representing PCM audio data for each channel.
   *              The audio is adjusted for the sprite's playback rate.
   *   - `done`: A boolean indicating if the underlying clip has finished playing (`true`) or not (`false`).
   */
  async offscreenRender(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    time: number, // This is the external time, e.g., from a global timeline
  ): Promise<{
    audio: Float32Array[];
    done: boolean;
  }> {
    // Adjust the time based on the sprite's playback rate to get the local clip time.
    const localTime = time * this.time.playbackRate;

    // Update sprite's animation properties (e.g., from keyframes) based on the local clip time.
    this.animate(localTime);
    // Apply transformations (translate, rotate, scale) to the context based on sprite's current state.
    super._render(ctx);

    const { w, h } = this.rect; // Get current width and height of the sprite.

    // Tick the underlying clip at the local time to get video and audio data.
    const {
      video: currentVideoFrame, // Current video frame from the clip, if any.
      audio: currentAudioData, // Current audio data from the clip, if any.
      state, // State of the clip ('success', 'done').
    } = await this.#clip.tick(localTime);

    let outputAudio = currentAudioData ?? []; // Default to empty array if no audio.
    // If audio data exists and playback rate is not normal, adjust PCM data speed.
    if (currentAudioData != null && this.time.playbackRate !== 1) {
      outputAudio = currentAudioData.map((pcmChan) =>
        changePCMPlaybackRate(pcmChan, this.time.playbackRate),
      );
    }

    // If the clip's state is 'done', it means it has no more data to provide.
    if (state === 'done') {
      return {
        audio: outputAudio,
        done: true,
      };
    }

    // Determine the image source to draw: current frame or the last valid frame.
    const imageToRender = currentVideoFrame ?? this.#lastVf;
    if (imageToRender != null) {
      // Draw the image centered within the sprite's transformed rectangle.
      // (-w / 2, -h / 2) positions the top-left corner of the image relative to the
      // sprite's center, which is assumed to be the origin after transformations.
      ctx.drawImage(imageToRender, -w / 2, -h / 2, w, h);
    }

    // If a new video frame was received, update the last video frame cache.
    if (currentVideoFrame != null) {
      this.#lastVf?.close(); // Close the previously cached frame to free resources.
      this.#lastVf = currentVideoFrame; // Cache the new frame.
    }

    return {
      audio: outputAudio,
      done: false, // Clip is not done yet.
    };
  }

  /**
   * Creates a new OffscreenSprite instance that is a clone of the current sprite.
   * The underlying clip is also cloned.
   * @returns {Promise<OffscreenSprite>} A promise that resolves to the cloned OffscreenSprite.
   */
  async clone(): Promise<this> {
    // Clone the underlying clip first.
    const clonedClip = await this.#clip.clone();
    // Create a new sprite with the cloned clip.
    const clonedSprite = new OffscreenSprite(clonedClip);
    // Wait for the new sprite to be ready (which depends on the cloned clip's readiness).
    await clonedSprite.ready;
    // Copy all state (rect, time, zIndex, opacity, etc.) from the current sprite to the new one.
    this.copyStateTo(clonedSprite);
    return clonedSprite as this;
  }

  /**
   * Destroys the sprite and releases its resources.
   * This includes closing any cached video frames and destroying the underlying clip.
   */
  destroy(): void {
    if (this.#destroyed) return; // Prevent multiple destructions.
    this.#destroyed = true;

    console.log(this.#logPrefix, 'destroy');
    super.destroy(); // Call base class destroy for common cleanup.
    this.#lastVf?.close(); // Close any cached video frame.
    this.#lastVf = null;
    this.#clip.destroy(); // Destroy the underlying clip.
  }
}
```
