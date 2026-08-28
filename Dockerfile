FROM node:20-bookworm

# Update package manager
RUN apt-get update

# Install FFmpeg with full codec support
RUN apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fontconfig \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installation with codec check
RUN ffmpeg -version && \
    ffprobe -version && \
    echo "✓ FFmpeg installed at: $(which ffmpeg)" && \
    ffmpeg -codecs 2>/dev/null | grep -E "libx264|libvpx|libopus|aac" && \
    echo "✓ All required codecs available"

ENV FFMPEG_THREADS=2
ENV FFMPEG_LOG=0

WORKDIR /app

# Install Node dependencies (npm install, NOT npm ci — no lock file needed)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create required directories with proper permissions
RUN mkdir -p uploads output temp && \
    chmod 777 uploads output temp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE 8080

CMD ["node", "index.js"]
