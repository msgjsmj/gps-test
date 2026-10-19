// In-page camera (getUserMedia) so the page stays alive at the shutter moment
// and can read position and heading then. One stream at a time: a newer open
// or a close cancels an open that is still in flight.

let stream = null;
let generation = 0;

export const cameraSupported = () => !!navigator.mediaDevices?.getUserMedia;

const cancelled = () => Object.assign(new Error('camera open cancelled'), { name: 'CameraCancelled' });

function stop(video) {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

// Resolves once frames are flowing. Rejects with name 'CameraCancelled' when
// closeCamera() ran meanwhile. onEnded fires if the camera goes away later.
export async function openCamera(video, onEnded) {
  const mine = ++generation;
  stop(video);
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  if (mine !== generation) {
    s.getTracks().forEach((t) => t.stop());
    throw cancelled();
  }
  stream = s;
  s.getVideoTracks().forEach((t) => t.addEventListener('ended', () => mine === generation && onEnded?.()));
  video.srcObject = s;
  try {
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener('emptied', resolve, { once: true }); // closed meanwhile
      });
    }
  } catch (e) {
    throw mine === generation ? e : cancelled();
  }
  if (mine !== generation) throw cancelled();
}

export function closeCamera(video) {
  generation++;
  stop(video);
}

export const cameraLive = (video) => !!stream?.active && video.videoWidth > 0;

// Draws the current frame synchronously; only the JPEG encoding is async.
export function captureFrame(video, quality = 0.85) {
  if (!video.videoWidth) return Promise.reject(new Error('no camera frame'));
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => {
      c.width = c.height = 0; // release canvas memory (iOS caps the total)
      b ? resolve(b) : reject(new Error('encode failed'));
    }, 'image/jpeg', quality),
  );
}
