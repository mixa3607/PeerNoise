ARG DENO_IMAGE=denoland/deno:2.9.6
FROM ${DENO_IMAGE}

USER root
WORKDIR /app
RUN mkdir -p /deno-dir && chown deno:deno /app /deno-dir
USER deno

COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno src/ ./src/
RUN deno cache --frozen src/main.ts

EXPOSE 6881/tcp 6881/udp 9090/tcp
ENTRYPOINT ["deno", "run", "--cached-only", "--frozen", "--allow-net", "--allow-read", "--allow-env", "src/main.ts"]
CMD ["/config/config.yaml"]
