"""Capture a labelled presentation-attack dataset from this camera.

Why this has to be captured rather than simulated
-------------------------------------------------
The two passive checks tried before this could be pre-tested without filming
anything, because their physics simulate exactly: a homography is precisely
what a plane does under rotation, and two press photographs of one person are
genuinely a 3D face at two poses.

A spoof capture cannot be faked that way. The entire signal is sensor-level --
ink dots and paper grain on a print, a pixel grid and backlight spectrum on a
screen, subsurface scattering in real skin. Simulate those and a classifier
learns the simulation. So this is the one that needs a real camera, real prints
and real screens.

What to capture, and the trap to avoid
--------------------------------------
The classic way this goes wrong is that the model learns the *conditions* and
not the attack. If every real sample is captured in the morning by the window
and every spoof in the evening under a lamp, a classifier will happily separate
them at 99% and then fail on the first attacker who stands somewhere else.

So: capture real and spoof for one person **in the same session, in the same
light, back to back**, and move between a few different lightings and distances
within each. This tool records the label and the free-text condition with every
frame so the evaluation can hold them out properly afterwards.

    python tools/collect_pad.py --person naman --label real     --condition window
    python tools/collect_pad.py --person naman --label screen   --condition window
    python tools/collect_pad.py --person naman --label print    --condition window

Then move to a different light and repeat all three.

Aim for roughly:

    real     4-6 people, ~2 minutes each, varying distance and angle
    screen   the same faces shown on a phone, held at varying distance
    print    the same faces printed, matte and glossy if both are available

Screen replay matters more than print in practice. Almost nobody prints a
photograph any more; everybody has a phone.

And capture on more than one camera if the detector is ever meant to work on
more than one. Cross-camera is where these break: every sensor has its own
colour science and its own sharpening, and a model trained on one learns what
skin looks like *through that lens*. Three or four cameras is the cheapest fix
there is, because each additional one forces the model toward what they share.

Keys while it runs:  SPACE saves a frame,  a toggles autosave,  q quits.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import recognition  # noqa: E402
from config import settings  # noqa: E402

LABELS = ("real", "print", "screen", "video")
GREEN, RED, WHITE = (0, 220, 0), (0, 0, 255), (240, 240, 240)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--person", required=True, help="whose face this is")
    parser.add_argument("--label", required=True, choices=LABELS)
    parser.add_argument(
        "--condition",
        required=True,
        help="lighting and setting, e.g. window / lamp / dim. Held out during "
        "evaluation, so be accurate rather than tidy.",
    )
    parser.add_argument(
        "--device",
        required=True,
        help="which camera this is, e.g. laptop-webcam / redmi-front / logitech-c270. "
        "Recorded because cross-camera is where a spoof detector actually breaks, "
        "and without this label there is no way to find out that it has.",
    )
    parser.add_argument("--out", default="../benchmark-data/pad")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument(
        "--autosave-every", type=float, default=0.4, help="seconds between autosaves"
    )
    args = parser.parse_args()

    out = Path(args.out).resolve() / args.label
    out.mkdir(parents=True, exist_ok=True)
    index = out.parent / "index.jsonl"

    print("loading the detector...")
    recognition.warm_up()

    camera = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
    if not camera.isOpened():
        print(f"could not open camera {args.camera}", file=sys.stderr)
        return 1

    saved = 0
    autosave = False
    last_save = 0.0

    print(
        f"\n{args.label}  ({args.person}, {args.condition})\n"
        "SPACE saves a frame   a toggles autosave   q quits\n"
    )

    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                break

            # Only crops that would actually reach the embedding stage are worth
            # keeping. A classifier trained on frames the pipeline would have
            # thrown away is answering a question nobody asks it.
            face, reason = None, "no_face_detected"
            try:
                face, reason = _usable(frame)
            except Exception as cause:  # noqa: BLE001
                reason = str(cause)

            view = frame.copy()
            if face is not None:
                x1, y1, x2, y2 = face.bbox
                cv2.rectangle(view, (x1, y1), (x2, y2), GREEN, 2)

            cv2.putText(
                view,
                f"{args.label} | {args.person} | {args.condition} | "
                f"{args.device} | saved {saved}"
                + ("  [AUTO]" if autosave else ""),
                (12, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                WHITE if face is not None else RED,
                2,
            )
            if face is None:
                cv2.putText(
                    view, reason, (12, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.6, RED, 2
                )

            cv2.imshow("FacePay - PAD capture", view)
            key = cv2.waitKey(1) & 0xFF

            if key == ord("q"):
                break
            if key == ord("a"):
                autosave = not autosave

            now = time.monotonic()
            wants = key == ord(" ") or (
                autosave and now - last_save >= args.autosave_every
            )

            if wants and face is not None:
                x1, y1, x2, y2 = face.bbox
                # A margin, because paper edges and phone bezels live just
                # outside the face box and are the most obvious tell there is.
                # Leaving them in would let the classifier win without ever
                # looking at skin, which is not a result that transfers.
                pad = int(0.25 * (y2 - y1))
                crop = frame[
                    max(y1 - pad, 0) : y2 + pad, max(x1 - pad, 0) : x2 + pad
                ]

                name = f"{args.person}_{args.device}_{args.condition}_{saved:04d}.png"
                cv2.imwrite(str(out / name), crop)

                with index.open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(
                            {
                                "file": f"{args.label}/{name}",
                                "label": args.label,
                                "person": args.person,
                                "condition": args.condition,
                                "device": args.device,
                                "det_score": round(float(face.det_score), 4),
                            }
                        )
                        + "\n"
                    )

                saved += 1
                last_save = now
    finally:
        camera.release()
        cv2.destroyAllWindows()

    print(f"\nsaved {saved} crops to {out}")
    print(f"index: {index}")
    return 0


def _usable(frame):
    """The same gate the live pipeline applies, so samples match production."""
    faces = recognition.detect_faces(frame)
    if not faces:
        return None, "no_face_detected"

    faces = sorted(faces, key=lambda f: f.bbox_area, reverse=True)
    face = faces[0]

    if face.det_score < settings.det_score_threshold:
        return None, "low_detection_confidence"
    if face.height < settings.min_face_height_ratio * frame.shape[0]:
        return None, "face_too_small - move closer"
    return face, "ok"


if __name__ == "__main__":
    raise SystemExit(main())
