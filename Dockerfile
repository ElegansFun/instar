# The world runtime is Node only. The engine (sim/) is built separately in WSL
# and shipped as site/instar_sim.wasm; the program (program/) is deployed
# separately and only its IDL (services/chain/idl/) ships here. The container
# must never compile Rust, or Railway's builder detects a Cargo.toml and builds
# the wrong thing.
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev

COPY . .

ENV PORT=8787
ENV DATA_DIR=/data
EXPOSE 8787

CMD ["npm", "start"]
