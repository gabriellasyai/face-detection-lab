FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates ffmpeg unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install

# Download ONNX models from HuggingFace (InsightFace buffalo_l)
RUN mkdir -p models && \
    curl -L -o models/det_10g.onnx "https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/insightface/models/buffalo_l/det_10g.onnx" && \
    curl -L -o models/2d106det.onnx "https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/insightface/models/buffalo_l/2d106det.onnx" && \
    curl -L -o models/w600k_r50.onnx "https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/insightface/models/buffalo_l/w600k_r50.onnx" && \
    echo "Models downloaded:" && ls -lh models/

# Copy app
COPY src/ ./src/
COPY public/ ./public/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.mjs"]
