FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS go
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS build
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /build
COPY scripts/build-server.mjs scripts/build-server.mjs
COPY overlay overlay
RUN node scripts/build-server.mjs

# Retain pinned upstream init-db/keygen; replace only the server executable.
FROM tinode/tinode-postgres:0.25.3@sha256:0df104ad2a96438b7581f71168518ffa103d0c9a5ec6ce2db6ef8649bd9e0ca5
COPY --from=build /build/.local/server/tinode /opt/tinode/tinode
