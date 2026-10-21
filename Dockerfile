FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 bxagi
WORKDIR /app
COPY --chown=bxagi:bxagi worker/ worker/
USER bxagi
CMD ["python", "worker/run.py"]
