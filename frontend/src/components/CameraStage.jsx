/**
 * Where to stand, drawn on the preview.
 *
 * A guide only. The frame sent to the server is the whole frame, uncropped —
 * cropping to this oval would cut the face of anyone standing slightly off
 * centre, and the embedding is built from an aligned crop, so a clipped chin
 * costs recognition accuracy for no security gain. Nothing here decides
 * anything; the server still sees, and still refuses, a second face.
 *
 * What it does buy is framing, and the size of it is now load-bearing. People
 * fill the shape they are given, and the anti-spoof models need the face at
 * roughly 38-50% of frame height -- that is where every reference sample they
 * classify correctly sits, while a face filling the frame collapses their crop
 * to 1.2 and the verdict gets thrown away. So this oval is 44% of the frame
 * rather than the 63% it started at: far enough back for the spoof check, still
 * comfortably above the server's minimum face height and its sharpness floor.
 *
 * It also, without having to say so, discourages standing somewhere with
 * another person in shot behind you.
 */
function FaceGuide({ tone }) {
  return (
    <svg
      className={`face-guide face-guide-${tone}`}
      viewBox="0 0 300 400"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <mask id="face-guide-cutout">
          <rect width="300" height="400" fill="white" />
          <ellipse cx="150" cy="182" rx="66" ry="88" fill="black" />
        </mask>
      </defs>
      <rect
        className="face-guide-shade"
        width="300"
        height="400"
        mask="url(#face-guide-cutout)"
      />
      <ellipse className="face-guide-ring" cx="150" cy="182" rx="66" ry="88" />
    </svg>
  );
}

/**
 * The camera viewport, shared by enrollment and verification.
 *
 * Owns only the presentation: the live preview, the framing guide, and the
 * states where there is no preview to show. Whatever is overlaid on top is the
 * caller's business.
 *
 * `guide` is 'idle' before anything is known, 'ok' once a single face is being
 * tracked, 'warn' when it is not — and 'off' for callers that want the bare
 * preview.
 */
export function CameraStage({ camera, children, guide = 'idle' }) {
  const { videoRef, status, problem, retry } = camera;

  return (
    <div className="stage">
      <video ref={videoRef} playsInline muted autoPlay />

      {status === 'ready' && guide !== 'off' && <FaceGuide tone={guide} />}

      {status === 'starting' && (
        <div className="stage-status">
          <div className="spinner" />
          <p className="muted">Starting the camera…</p>
        </div>
      )}

      {status === 'error' && problem && (
        <div className="stage-status">
          <div className="badge fail" aria-hidden="true">
            !
          </div>
          <h2>{problem.title}</h2>
          <p className="muted">{problem.detail}</p>
          <button className="btn btn-secondary" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && <div className="stage-overlay">{children}</div>}
    </div>
  );
}
