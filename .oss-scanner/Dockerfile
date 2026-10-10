# Anthropic OSS Scanner uses the cloned Agent Bridge repository as build context.
# Network access is available during image creation, but not during the audit.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY . /src
WORKDIR /src

# Install native dependencies and compile TypeScript before the offline scan.
RUN npm ci --no-audit --no-fund
RUN npm run build && npm run typecheck

CMD ["bash"]
