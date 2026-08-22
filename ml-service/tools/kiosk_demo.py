"""A working kiosk, driven from the webcam, before any frontend exists.

Talks to the Node API rather than the ML service directly, so it exercises the
real path: encryption, the candidate pool, the audit log, all of it.

    python tools/kiosk_demo.py enroll --name "Your Name" --region delhi
    python tools/kiosk_demo.py verify --merchant shop-1

Enrollment walks through the guidance prompts; press SPACE to take each sample.
Verification streams frames automatically and shows the challenge as the server
issues it. Press Q to quit either.

Both services must be running:
    ml-service> python app.py
    backend>    npm start
"""

import argparse
import base64
import sys
import time
from pathlib import Path

import cv2
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

API = "http://127.0.0.1:3000"
WINDOW = "FacePay kiosk"
GREEN, RED, AMBER, WHITE = (0, 220, 0), (0, 0, 255), (0, 190, 255), (240, 240, 240)
FONT = cv2.FONT_HERSHEY_SIMPLEX


def open_camera(index: int = 0):
    """Prefer DirectShow on Windows — MSMF can take ten seconds to open."""
    backends = (
        [cv2.CAP_DSHOW, cv2.CAP_ANY] if sys.platform == "win32" else [cv2.CAP_ANY]
    )
    for backend in backends:
        camera = cv2.VideoCapture(index, backend)
        if camera.isOpened() and camera.read()[0]:
            return camera
        camera.release()
    return None


def encode(frame) -> str:
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise RuntimeError("failed to encode frame")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def post(path: str, payload: dict) -> dict:
    # Drop keys with no value rather than sending an explicit null. The API
    # accepts either, but omitting them keeps the request honest about what the
    # caller actually knows.
    body = {key: value for key, value in payload.items() if value is not None}

    try:
        response = requests.post(f"{API}{path}", json=body, timeout=20)
    except requests.RequestException as exc:
        raise SystemExit(f"\nCannot reach the API at {API}: {exc}") from exc

    if response.status_code < 400:
        return response.json()

    error = (response.json() if response.content else {}).get("error", {})
    message = error.get("message", response.text)

    # A validation failure names the offending fields, and printing only the
    # summary throws that away — leaving "Request body failed validation" with
    # nothing to act on.
    detail = "".join(
        f"\n    {issue.get('field') or '(body)'}: {issue.get('message')}"
        for issue in error.get("issues", [])
    )
    raise SystemExit(f"\n{path} failed ({response.status_code}): {message}{detail}")


def overlay(frame, lines: list[tuple[str, tuple[int, int, int], float]]) -> None:
    """Dim a strip behind the text so thin strokes stay readable over a face."""
    if not lines:
        return

    height = min(int(sum(28 * scale for _, _, scale in lines)) + 18, frame.shape[0])
    frame[:height, :] = (frame[:height, :] * 0.35).astype(frame.dtype)

    y = 10
    for text, colour, scale in lines:
        y += int(26 * scale)
        cv2.putText(frame, text, (14, y), FONT, 0.6 * scale, colour, 1, cv2.LINE_AA)


def run_enroll(args) -> int:
    session = post(
        "/api/enroll/start",
        {"displayName": args.name, "region": args.region, "merchantId": args.merchant},
    )
    required = session["samplesRequired"]
    guidance = session["guidance"]

    print(f"Enrolling {args.name}. {required} samples needed.")
    print("Press SPACE to capture, Q to abort.\n")

    camera = open_camera()
    if camera is None:
        print("Could not open the webcam.")
        return 1

    accepted, last_reason = 0, None
    try:
        while accepted < required:
            ok, frame = camera.read()
            if not ok:
                break

            prompt = guidance[min(accepted, len(guidance) - 1)]
            lines = [
                (f"Sample {accepted + 1} of {required}", WHITE, 1.0),
                (prompt, GREEN, 1.3),
                ("SPACE to capture", WHITE, 0.9),
            ]
            if last_reason:
                lines.append((f"rejected: {last_reason}", RED, 0.9))

            shown = frame.copy()
            overlay(shown, lines)
            cv2.imshow(WINDOW, shown)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                return 1
            if key != ord(" "):
                continue

            result = post(
                "/api/enroll/capture",
                {"sessionId": session["sessionId"], "image": encode(frame)},
            )
            if result["accepted"]:
                accepted += 1
                last_reason = None
                print(f"  sample {accepted}/{required} accepted")
            else:
                last_reason = result["reason"]
                print(f"  rejected: {last_reason}")
    finally:
        camera.release()
        cv2.destroyAllWindows()

    done = post("/api/enroll/finalize", {"sessionId": session["sessionId"]})
    enrollment = done["enrollment"]

    print(f"\nEnrolled as {done['userId']}")
    print(f"  samples used      {enrollment['samplesUsed']}")
    print(f"  mean similarity   {enrollment['meanSimilarity']}")
    print(f"  outliers dropped  {enrollment['outliersDropped']}")

    # Samples that disagree with each other mean the stored identity is a
    # blurred average, and every future match against it will be weaker.
    if enrollment["meanSimilarity"] < 0.85:
        print("\n  Warning: the samples disagreed more than expected.")
        print("  Re-enrol with steadier lighting and less head movement.")
    return 0


def run_verify(args) -> int:
    session = post(
        "/api/verify/start",
        {"merchantId": args.merchant, "deviceId": args.device, "region": args.region},
    )
    print(f"Challenge: {session['prompt']}\n")

    camera = open_camera()
    if camera is None:
        print("Could not open the webcam.")
        return 1

    status, prompt, progress, step = "in_progress", session["prompt"], 0.0, 0
    total = session["totalSteps"]
    started = time.monotonic()

    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                break

            if status == "in_progress":
                # Sent as a one-frame batch with its capture time. Running
                # against a local service this is barely different from sending
                # frames singly, but the API is the batched one and the capture
                # timestamp is what the blink window is measured against.
                result = post(
                    "/api/verify/frame",
                    {
                        "sessionId": session["sessionId"],
                        "frames": [
                            {
                                "image": encode(frame),
                                "capturedAtMs": time.monotonic() * 1000.0,
                            }
                        ],
                    },
                )
                status = result["status"]
                prompt = result["prompt"] or prompt
                progress = result["stepProgress"]
                step = result["stepIndex"]
                face = result["faceDetected"]

                if status != "in_progress":
                    print(f"Liveness {status} after {time.monotonic() - started:.1f}s")
                    if result["failureReason"]:
                        print(f"  reason: {result['failureReason']}")
            else:
                face = True

            colour = {
                "in_progress": AMBER,
                "passed": GREEN,
                "failed": RED,
            }[status]

            shown = frame.copy()
            overlay(
                shown,
                [
                    (f"step {min(step + 1, total)} of {total}", WHITE, 0.9),
                    (prompt if status == "in_progress" else status.upper(), colour, 1.4),
                    (
                        "#" * int(progress * 24) if status == "in_progress" else "",
                        colour,
                        0.9,
                    ),
                    ("" if face else "no face detected", RED, 0.9),
                ],
            )
            cv2.imshow(WINDOW, shown)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q") or status == "failed":
                if status == "failed":
                    cv2.waitKey(1200)
                return 1 if status == "failed" else 0
            if status == "passed":
                cv2.waitKey(400)
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()

    if status != "passed":
        return 1

    print("Identifying...")
    result = post("/api/verify/match", {"sessionId": session["sessionId"]})

    print(f"\n  decision      {result['decision']}")
    print(f"  top score     {result['confidence']['top']}")
    print(f"  runner-up     {result['confidence']['runnerUp']}")
    print(f"  margin        {result['confidence']['margin']}")
    print(f"  gallery size  {result['gallerySize']}")
    print(f"  next step     {result['nextStep']}")

    if result["user"]:
        print(f"\n  Identified as {result['user']['displayName']}")
    elif result["decision"] == "ambiguous":
        print("\n  Two candidates too close to separate — a second factor decides.")
    else:
        print("\n  No enrolled user matched.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    enroll = sub.add_parser("enroll", help="register a face")
    enroll.add_argument("--name", required=True)
    enroll.add_argument("--region", default=None)
    enroll.add_argument("--merchant", default=None)
    enroll.set_defaults(handler=run_enroll)

    verify = sub.add_parser("verify", help="identify a face")
    verify.add_argument("--merchant", default="shop-1")
    verify.add_argument("--device", default="kiosk-1")
    verify.add_argument("--region", default=None)
    verify.set_defaults(handler=run_verify)

    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
