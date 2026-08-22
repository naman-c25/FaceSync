# The whole app in one image: kiosk, API, and ML service.
#
# The two services stay separate programs — the Python side knows nothing about
# the database, the Node side does no ML — but they are deployed together on
# purpose. Every liveness frame travels browser -> Node -> Python and back, and
# splitting them across two hosts adds a network hop to each of the 20-30
# frames in one verification. Co-located, that call is over loopback.
#
# Any host that takes a Dockerfile will run this. The constraint to check
# before picking one is memory: the models want roughly a gigabyte, which rules
# out the 512MB free tiers most platforms offer. See DEPLOY.md.

# --- build the kiosk ------------------------------------------------------
# A separate stage so the frontend's build tooling never reaches the runtime
# image, and so no build output has to be committed to get one URL serving
# everything.
FROM node:22-slim AS kiosk

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# No VITE_API_URL: served from the same origin as the API, so relative paths
# are correct and CORS never comes into it.
RUN npm run build


# --- runtime --------------------------------------------------------------
FROM python:3.12-slim

# Node for the API layer; libgl/libglib are what OpenCV links against even
# headless; curl backs the healthcheck and the startup wait.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg libgl1 libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user, with a home directory the model cache can write to.
RUN useradd -m -u 1000 app
WORKDIR /home/app

COPY --chown=app:app ml-service/requirements.txt ml-service/
RUN pip install --no-cache-dir -r ml-service/requirements.txt

COPY --chown=app:app backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

COPY --chown=app:app ml-service/ ml-service/
COPY --chown=app:app backend/ backend/
COPY --chown=app:app docker-start.sh .

# The Node service serves this directory if it exists, giving one origin for
# the kiosk and the API.
COPY --from=kiosk --chown=app:app /build/dist backend/public

USER app

# Bake the models in. Downloading them on first request would mean the first
# person to open the link waits out 300MB — and on a link shared with friends,
# that is most people.
RUN cd ml-service && python setup_models.py

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    FACEPAY_PORT=8001 \
    ML_SERVICE_URL=http://127.0.0.1:8001 \
    PORT=7860

# Most platforms inject their own PORT; 7860 is only a default.
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["bash", "docker-start.sh"]
