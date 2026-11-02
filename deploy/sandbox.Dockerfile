FROM python:3.12-slim
# bash: tool scripts are bash entrypoints. duckdb: the read-only project tools
# query the real warehouse/read-model parquet instead of inventing observations.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --quiet duckdb==2.0.0
WORKDIR /tmp
CMD ["sleep", "infinity"]
