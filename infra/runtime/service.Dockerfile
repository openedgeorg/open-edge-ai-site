FROM python:3.12-slim
WORKDIR /app
RUN useradd --create-home --uid 10001 esp
USER esp
# Packaging skeleton. No provider credentials and no qualified profile are baked in.
CMD ["python", "-c", "print('esp service skeleton')"]
