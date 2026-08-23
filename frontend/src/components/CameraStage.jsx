/**
 * Where to stand, drawn on the preview.
 *
 * A guide only. The frame sent to the server is the whole frame, uncropped —
 * cropping to this oval would cut the face of anyone standing slightly off
 * centre, and the embedding is built from an aligned crop, so a clipped chin
 * costs recognition accuracy for no security gain. Nothing here decides
 * anything; the server still sees, and still refuses, a second face.
 *
 * What it does buy is framing, and the size of it is load-bearing. People fill
 * the shape they are given, and where that lands the face decides two things
 * at once.
 *
 * The anti-spoof models crop outward from the face by a fixed factor, so the
 * bigger the face the less they get: at 46% of frame height they achieve about
 * 2.2, which is inside the 1.90-2.62 band every reference sample they classify
 * correctly sits in. A face *filling* the frame collapses that to 1.2, which is
 * where the one sample they get wrong sits and where the verdict is thrown
 * away instead. 63%, which this started at, was over that line.
 *
 * Pulling further back is not free either. Measured on one real face at three
 * framings, the score went 0.901 at 43% of frame height, 0.778 at 25% and
 * 0.729 at 19.6% -- so more surrounding scene made a genuine face look *less*
 * genuine, not more. One measurement is not a finding, but it is enough to
 * stop treating "further back is safer" as obvious.
 *
 * Standing closer also puts less room in shot behind the customer, which makes
 * a bystander proportionally smaller and the dominance rule easier -- and it
 * discourages, without having to say so, standing somewhere with another
 * person in view.
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
          <ellipse cx="150" cy="182" rx="69" ry="92" fill="black" />
        </mask>
      </defs>
      <rect
        className="face-guide-shade"
        width="300"
        height="400"
        mask="url(#face-guide-cutout)"
      />
      <ellipse className="face-guide-ring" cx="150" cy="182" rx="69" ry="92" />
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
