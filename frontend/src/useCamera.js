import { useCallback, useEffect, useRef, useState } from 'react';

// Longest edge of a captured frame. Small enough that a phone on mobile data
// can send several per second, large enough that the face still lands well
// above the 112px ArcFace works from.
const MAX_DIMENSION = 540;
const JPEG_QUALITY = 0.8;

/**
 * Explain a getUserMedia failure in terms someone can act on.
 *
 * The insecure-context case is the one that catches people out when deploying:
 * browsers only expose a camera over HTTPS (localhost excepted), and the API
 * is simply missing rather than throwing something descriptive.
 */
function describe(error) {
  if (error === 'insecure') {
    return {
      title: 'Camera needs a secure connection',
      detail:
        'Browsers only allow camera access over HTTPS. Open this page with ' +
        'https:// — or on localhost during development.',
    };
  }

  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Camera permission denied',
        detail:
          'Allow camera access for this site, then reload. On a phone this ' +
          'is under the padlock or "aA" icon in the address bar.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        title: 'No camera found',
        detail: 'This device has no camera available to the browser.',
      };
    case 'NotReadableError':
      return {
        title: 'Camera is busy',
        detail:
          'Another app or tab is using the camera. Close it and reload.',
      };
    default:
      return {
        title: 'Could not start the camera',
        detail: error?.message ?? 'Unknown error.',
      };
  }
}

export function useCamera(active) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);

  const [status, setStatus] = useState('idle');
  const [problem, setProblem] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;

    let cancelled = false;

    async function start() {
      setStatus('starting');
      setProblem(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(describe('insecure'));
        setStatus('error');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setProblem(describe(error));
        setStatus('error');
      }
    }

    start();

    return () => {
      cancelled = true;
      // Releasing the tracks is what turns the camera light off. Leaving them
      // running after the flow ends is alarming to the person being filmed.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus('idle');
    };
  }, [active, attempt]);

  /**
   * Grab the current frame as base64 JPEG, or null if the video is not ready.
   *
   * The preview is mirrored in CSS because an unmirrored self-view feels
   * wrong to look at, but the frame drawn here is *not* mirrored — the backend
   * reads gaze direction in image coordinates and assumes an unflipped frame,
   * so mirroring here would invert every "look left".
   */
  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight),
    );
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);

    const canvas = (canvasRef.current ??= document.createElement('canvas'));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, width, height);

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { videoRef, status, problem, capture, retry };
}
