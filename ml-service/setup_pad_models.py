"""Fetch the anti-spoofing models.

Two MiniFASNets from minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0),
converted to ONNX by QingHeYang/Silent-Face-Anti-Spoofing-onnx. 3.4MB together,
against 300MB for the InsightFace pack, and they run on the ONNX Runtime that
is already loaded.

Kept out of the repository and fetched here for the same reason the InsightFace
models are: binaries do not belong in git, and a checkout should say what it
needs rather than carry it.

    python setup_pad_models.py
"""

import sys
import urllib.parse
import urllib.request

from pad import MODEL_DIR, MODELS

BASE_URL = (
    "https://raw.githubusercontent.com/QingHeYang/"
    "Silent-Face-Anti-Spoofing-onnx/main/onnx/"
)

# Under a megabyte means something went wrong -- a 404 page, a redirect, a
# truncated download. Each real model is about 1.7MB, and a file that is
# present but wrong is worse than one that is missing, because the service
# would load it and answer confidently.
MIN_BYTES = 1_000_000


def main() -> int:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    for name in MODELS:
        target = MODEL_DIR / name
        if target.is_file() and target.stat().st_size >= MIN_BYTES:
            print(f"  {name}  already present")
            continue

        url = BASE_URL + urllib.parse.quote(name)
        print(f"  {name}  downloading...")
        try:
            urllib.request.urlretrieve(url, target)
        except Exception as cause:  # noqa: BLE001
            print(f"\nfailed to fetch {url}\n{cause}", file=sys.stderr)
            return 1

        size = target.stat().st_size
        if size < MIN_BYTES:
            target.unlink(missing_ok=True)
            print(
                f"\n{name} came back as {size} bytes, which is not a model.\n"
                f"Check {url}",
                file=sys.stderr,
            )
            return 1
        print(f"  {name}  {size:,} bytes")

    print(f"\nanti-spoofing models are in {MODEL_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
