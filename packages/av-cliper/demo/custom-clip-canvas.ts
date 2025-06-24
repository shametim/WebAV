import { Combinator, OffscreenSprite } from '../src/index';
import type { IClip } from '../src/clips/iclip'; // Assuming IClip is exported this way
import { tmpfile, write } from 'opfs-tools'; // For saving the file

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 360;
const VIDEO_DURATION_SECONDS = 5;
const VIDEO_DURATION_MICROSECONDS = VIDEO_DURATION_SECONDS * 1_000_000;
const FRAME_RATE = 30; // fps

class CanvasAnimationClipping implements IClip {
    #meta: IClip['meta'];
    ready: IClip['ready'];
    #offscreenCanvas: OffscreenCanvas;
    #ctx: OffscreenCanvasRenderingContext2D;

    constructor(width: number, height: number, durationMicros: number) {
        this.#meta = {
            width,
            height,
            duration: durationMicros,
        };
        this.#offscreenCanvas = new OffscreenCanvas(width, height);
        const ctx = this.#offscreenCanvas.getContext('2d');
        if (!ctx) {
            throw new Error('Failed to get OffscreenCanvas 2D context');
        }
        this.#ctx = ctx;
        this.ready = Promise.resolve(this.#meta);
        console.log('CanvasAnimationClipping initialized');
    }

    get meta() {
        return { ...this.#meta };
    }

    async tick(timeMicros: number): ReturnType<IClip['tick']> {
        if (timeMicros >= this.#meta.duration) {
            return { state: 'done' };
        }

        // Simple animation: a bouncing ball
        const seconds = timeMicros / 1_000_000;

        this.#ctx.fillStyle = 'lightblue';
        this.#ctx.fillRect(0, 0, this.#meta.width, this.#meta.height);

        const ballRadius = 30;
        const ballX = (seconds * 100) % (this.#meta.width - ballRadius * 2) + ballRadius;
        // Simple bounce effect for Y
        const yBase = this.#meta.height - ballRadius - 20;
        const yOffset = Math.abs(Math.sin(seconds * Math.PI * 2)) * (this.#meta.height / 3);
        const ballY = yBase - yOffset;


        this.#ctx.fillStyle = 'red';
        this.#ctx.beginPath();
        this.#ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
        this.#ctx.fill();

        this.#ctx.fillStyle = 'black';
        this.#ctx.font = '24px Arial';
        this.#ctx.fillText(`Time: ${seconds.toFixed(2)}s`, 10, 30);

        const videoFrame = new VideoFrame(this.#offscreenCanvas, {
            timestamp: timeMicros,
            duration: 1_000_000 / FRAME_RATE, // Duration of one frame
        });

        return {
            video: videoFrame,
            state: 'success',
        };
    }

    async clone(): Promise<this> {
        // For this simple example, a new instance is fine.
        // More complex clips might need to copy internal state.
        return new CanvasAnimationClipping(this.#meta.width, this.#meta.height, this.#meta.duration) as this;
    }

    // Optional: Implement split if needed, for now, it can be omitted or basic.
    // async split(time: number): Promise<[this, this]> {
    //   // Simplified: just return two clones, not a true split for this generated content
    //   const clone1 = await this.clone();
    //   const clone2 = await this.clone();
    //   // A real split would adjust durations and starting points.
    //   return [clone1, clone2];
    // }

    destroy(): void {
        // No specific resources to release for OffscreenCanvas in this simple case,
        // but good practice to have it.
        console.log('CanvasAnimationClipping destroyed');
    }
}

// --- UI and Combinator Logic ---
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const createVideoButton = document.getElementById('createVideoButton') as HTMLButtonElement;
const previewCanvas = document.getElementById('previewCanvas') as HTMLCanvasElement;
const previewCtx = previewCanvas.getContext('2d');

function updatePreview(timeSeconds: number) {
    if (!previewCtx) return;

    const timeMicros = timeSeconds * 1_000_000;

    previewCtx.fillStyle = 'lightblue';
    previewCtx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    const ballRadius = 30;
    const ballX = (timeSeconds * 100) % (VIDEO_WIDTH - ballRadius * 2) + ballRadius;
    const yBase = VIDEO_HEIGHT - ballRadius - 20;
    const yOffset = Math.abs(Math.sin(timeSeconds * Math.PI * 2)) * (VIDEO_HEIGHT / 3);
    const ballY = yBase - yOffset;

    previewCtx.fillStyle = 'red';
    previewCtx.beginPath();
    previewCtx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
    previewCtx.fill();

    previewCtx.fillStyle = 'black';
    previewCtx.font = '24px Arial';
    previewCtx.fillText(`Time: ${timeSeconds.toFixed(2)}s`, 10, 30);
}


async function main() {
    if (!Combinator.isSupported()) {
        statusEl.textContent = 'WebCodecs is not supported in this browser.';
        alert('WebCodecs is not supported in this browser.');
        return;
    }

    updatePreview(0); // Initial preview frame

    // Simple preview update over time
    let previewTime = 0;
    const previewInterval = setInterval(() => {
        previewTime = (previewTime + 0.05) % VIDEO_DURATION_SECONDS;
        updatePreview(previewTime);
    }, 50);


    createVideoButton.addEventListener('click', async () => {
        clearInterval(previewInterval); // Stop preview updates during processing
        statusEl.textContent = 'Processing video...';
        createVideoButton.disabled = true;

        let combinator: Combinator | null = null;
        let customClip: CanvasAnimationClipping | null = null;

        try {
            customClip = new CanvasAnimationClipping(
                VIDEO_WIDTH,
                VIDEO_HEIGHT,
                VIDEO_DURATION_MICROSECONDS
            );
            await customClip.ready;

            combinator = new Combinator({
                width: VIDEO_WIDTH,
                height: VIDEO_HEIGHT,
                videoCodec: 'avc1.42E01E', // Baseline profile, level 3.0
                bitrate: 2_000_000, // 2 Mbps
                fps: FRAME_RATE,
                // No audio for this custom clip
            });

            const sprite = new OffscreenSprite(customClip);
            await combinator.addSprite(sprite);

            statusEl.textContent = 'Encoding video... this may take a moment.';

            const outputStream = combinator.output();

            // Save using opfs-tools (alternative: showSaveFilePicker)
            const tempFileName = `custom-canvas-video-${Date.now()}.mp4`;
            const opfsFile = tmpfile(tempFileName);
            await write(opfsFile, outputStream);

            statusEl.textContent = `Video saved to OPFS: ${opfsFile.name}. You can view it using the OPFS Explorer extension or download it if the browser supports it.`;
            alert(`Video saved to OPFS: ${opfsFile.name}`);

            // Example for showSaveFilePicker if preferred:
            // const fileHandle = await window.showSaveFilePicker({
            //     suggestedName: `custom-canvas-video-${Date.now()}.mp4`,
            //     types: [{ accept: { 'video/mp4': ['.mp4'] } }],
            // });
            // const writable = await fileHandle.createWritable();
            // await outputStream.pipeTo(writable);
            // statusEl.textContent = 'Video saved successfully!';
            // alert('Video saved successfully!');

        } catch (error) {
            console.error('Error creating video:', error);
            statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
            alert(`Error creating video: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            customClip?.destroy();
            combinator?.destroy();
            createVideoButton.disabled = false;
            // Restart preview if desired, or leave it stopped
            // previewTime = 0; // Reset for next potential preview run
            // updatePreview(previewTime);
        }
    });
}

main().catch(err => {
    console.error("Initialization failed:", err);
    statusEl.textContent = `Initialization failed: ${err.message}`;
});

// Helper for showSaveFilePicker if that route is taken
// async function createFileWriter(extName: string) {
//   const fileHandle = await window.showSaveFilePicker({
//     suggestedName: `WebAV-customclip-${Date.now()}.${extName}`,
//   });
//   return fileHandle.createWritable();
// }
