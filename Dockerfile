FROM oven/bun:alpine AS base

FROM base AS frontend
WORKDIR /frontend
ADD frontend/package.json frontend/package-lock.json .
RUN bun install
ADD frontend .
RUN bun run build

FROM base AS final
WORKDIR /app
ADD package.json package-lock.json .
RUN bun install --no-save
ADD . .
COPY --from=frontend /frontend/dist frontend/dist
RUN mkdir data
EXPOSE 29138
ENTRYPOINT ["bun", "run", "./core/server.ts"]
