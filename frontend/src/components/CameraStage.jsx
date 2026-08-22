/**
 * The camera viewport, shared by enrollment and verification.
 *
 * Owns only the presentation: the live preview, and the states where there is
 * no preview to show. Whatever is overlaid on top is the caller's business.
 */
export function CameraStage({ camera, children }) {
  const { videoRef, status, problem, retry } = camera;

  return (
    <div className="stage">
      <video ref={videoRef} playsInline muted autoPlay />

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
