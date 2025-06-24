import { MP4Clip, Log, Combinator } from '../src/index';

const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const thumbnailContainer = document.getElementById('thumbnailContainer') as HTMLDivElement;

const MAX_THUMBNAILS = 5;

async function generateThumbnails(file: File) {
    statusEl.textContent = 'Processing video...';
    thumbnailContainer.innerHTML = ''; // Clear previous thumbnails

    let mp4Clip: MP4Clip | null = null;
    const generatedVideoFrames: VideoFrame[] = []; // To close them later

    try {
        // MP4Clip constructor expects a ReadableStream or specific file sources.
        // For a File object, we need to get its stream.
        mp4Clip = new MP4Clip(file.stream());
        statusEl.textContent = 'Loading video metadata...';
        await mp4Clip.ready;
        const clipMeta = mp4Clip.meta;
        statusEl.textContent = `Video loaded: ${clipMeta.width}x${clipMeta.height}, Duration: ${(clipMeta.duration / 1_000_000).toFixed(2)}s`;

        if (clipMeta.duration === 0 || clipMeta.duration === Infinity) {
            statusEl.textContent = 'Cannot generate thumbnails for a video with zero or infinite duration.';
            return;
        }

        const interval = clipMeta.duration / (MAX_THUMBNAILS + 1); // +1 to avoid thumbnail at the very end if possible

        for (let i = 1; i <= MAX_THUMBNAILS; i++) {
            const timestamp = i * interval;
            if (timestamp >= clipMeta.duration) break;

            statusEl.textContent = `Extracting frame at ${ (timestamp / 1_000_000).toFixed(2) }s...`;

            // The tick method returns video and audio frames. We only need video.
            // It's important to get the frame closest to the timestamp.
            // MP4Clip's tick should ideally handle seeking to the nearest keyframe and decoding up to the timestamp.
            const tickResult = await mp4Clip.tick(timestamp);

            if (tickResult.state === 'success' && tickResult.video) {
                const videoFrame = tickResult.video;
                // Keep track of frames to close them later
                // Note: If tickResult.video is an ImageBitmap, it doesn't need closing.
                // But MP4Clip usually yields VideoFrame.
                if (videoFrame instanceof VideoFrame) {
                    generatedVideoFrames.push(videoFrame.clone()); // Clone for safety if original is closed by clip
                }


                const canvas = document.createElement('canvas');
                canvas.width = 160; // Fixed thumbnail size
                canvas.height = 90;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Draw the VideoFrame onto the canvas
                    // Adjust drawing to maintain aspect ratio if necessary
                    const aspectRatio = videoFrame.displayWidth / videoFrame.displayHeight;
                    let drawWidth = canvas.width;
                    let drawHeight = canvas.height;
                    if (drawWidth / drawHeight > aspectRatio) {
                        drawWidth = drawHeight * aspectRatio;
                    } else {
                        drawHeight = drawWidth / aspectRatio;
                    }
                    const offsetX = (canvas.width - drawWidth) / 2;
                    const offsetY = (canvas.height - drawHeight) / 2;

                    ctx.drawImage(videoFrame, offsetX, offsetY, drawWidth, drawHeight);
                }
                thumbnailContainer.appendChild(canvas);
                canvas.classList.add('thumbnail');

                // Original videoFrame from tickResult should be closed if it's not needed anymore by the clip.
                // However, MP4Clip might reuse frames or manage their lifecycle.
                // Cloning it as done above for generatedVideoFrames is safer for long-term storage if needed.
                // If the frame from tick is directly used and not cloned, ensure clip.destroy() handles it or close it manually if clip doesn't.
                // For this demo, we rely on mp4Clip.destroy() to clean up its internal frames.
                // The cloned frames in generatedVideoFrames are explicitly closed in finally.
                if (videoFrame instanceof VideoFrame) {
                     videoFrame.close(); // Close the frame from tick if we are done with it for this iteration
                }


            } else if (tickResult.state === 'done') {
                statusEl.textContent = 'Reached end of video while extracting thumbnails.';
                break;
            }
        }
        if (generatedVideoFrames.length > 0) {
             statusEl.textContent = `Generated ${generatedVideoFrames.length} thumbnails.`;
        } else {
             statusEl.textContent = 'Could not generate any thumbnails. The video might be too short or there was an issue.';
        }

    } catch (error) {
        console.error('Error generating thumbnails:', error);
        statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
        Log.error(error);
    } finally {
        mp4Clip?.destroy();
        generatedVideoFrames.forEach(frame => frame.close());
        fileInput.value = ''; // Reset file input
    }
}


fileInput.addEventListener('change', async (event) => {
    const files = (event.target as HTMLInputElement).files;
    if (files && files.length > 0) {
        if (!await Combinator.isSupported()) {
            statusEl.textContent = 'WebCodecs is not supported in this browser.';
            alert('WebCodecs is not supported in this browser.');
            return;
        }
        await generateThumbnails(files[0]);
    } else {
        statusEl.textContent = 'Select a video file.';
        thumbnailContainer.innerHTML = '';
    }
});

statusEl.textContent = 'Select a video file.';
if (!Combinator.isSupported()) {
    statusEl.textContent = 'WebCodecs is not supported. Thumbnails cannot be generated.';
    fileInput.disabled = true;
}
