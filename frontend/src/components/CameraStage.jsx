/**
 * Where to stand, drawn on the preview.
 *
 * A guide only. The frame sent to the server is the whole frame, uncropped —
 * cropping to this oval would cut the face of anyone standing slightly off
 * centre, and the embedding is built from an aligned crop, so a clipped chin
 * costs recognition accuracy for no security gain. Nothing here decides
 * anything; the server still sees, and still refuses, a second face.
 *
 * What it does buy is framing. People fill the shape they are given, which
 * puts the face closer to the lens and larger in frame, and both feed straight
 * into sharpness and the minimum face height the server insists on. It also,
 * without having to say so, discourages standing somewhere with another person
 * in shot behind you.
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
          <ellipse cx="150" cy="176" rx="96" ry="127" fill="black" />
        </mask>
      </defs>
      <rect
        className="face-guide-shade"
        width="300"
        height="400"
        mask="url(#face-guide-cutout)"
      />
      <ellipse className="face-guide-ring" cx="150" cy="176" rx="96" ry="127" />
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
