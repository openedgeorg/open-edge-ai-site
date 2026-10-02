# Build from services/esp_embeddings.
# The image does not download model weights and has no hosted embedding route.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    ESP_EMBEDDINGS_NETWORK=deny \
    PYTHONPATH=/opt/esp-embeddings/src

WORKDIR /opt/esp-embeddings
COPY src /opt/esp-embeddings/src

USER nobody
ENTRYPOINT ["python", "-m", "esp_embeddings.main"]
