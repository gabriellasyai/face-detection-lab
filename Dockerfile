FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates ffmpeg unzip wget \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install

# Models are downloaded at startup if not present (avoids 288MB download during Docker build)
RUN mkdir -p models

# Startup script: download models if missing, then start server
RUN echo '#!/bin/bash\n\
cd /app\n\
if [ ! -f models/det_10g.onnx ] || [ $(stat -c%s models/det_10g.onnx 2>/dev/null || echo 0) -lt 1000 ]; then\n\
  echo "Downloading ONNX models..."\n\
  wget -q "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip" -O /tmp/buffalo_l.zip\n\
  unzip -q /tmp/buffalo_l.zip -d /tmp/buffalo_l\n\
  cp /tmp/buffalo_l/buffalo_l/det_10g.onnx models/\n\
  cp /tmp/buffalo_l/buffalo_l/2d106det.onnx models/\n\
  cp /tmp/buffalo_l/buffalo_l/w600k_r50.onnx models/\n\
  rm -rf /tmp/buffalo_l /tmp/buffalo_l.zip\n\
  echo "Models downloaded:" && ls -lh models/\n\
else\n\
  echo "Models already present:" && ls -lh models/\n\
fi\n\
exec node src/server.mjs\n' > /app/start.sh && chmod +x /app/start.sh

# Copy app
COPY src/ ./src/
COPY public/ ./public/

ENV PORT=3000
EXPOSE 3000

CMD ["/app/start.sh"]
