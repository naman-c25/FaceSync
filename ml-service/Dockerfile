# Python 3.12 rather than 3.14: the wheels this service needs exist for both,
# and 3.12 has the widest coverage if a dependency is added later.
FROM python:3.12-slim

# OpenCV links against these even in headless use, and the slim image has
# neither. Without them `import cv2` fails at runtime rather than at build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a code change does not re-resolve the whole tree.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bake the models into the image. Fetching them on first request instead would
# mean the first person to open the demo waits out a 300MB download, which on a
# free tier that sleeps between visits is most people.
RUN python setup_models.py

ENV FACEPAY_HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1

# Most hosts inject $PORT and expect the process to bind it.
ENV PORT=8001
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
