FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 USE_TF=0 \
    ML_MODEL_DIR=/models ML_REGISTRY_PATH=/config/registry.json ML_CPU_THREADS=2
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home ml
COPY saefr_ml ./saefr_ml
USER 10001:10001
EXPOSE 8001
CMD ["python", "-m", "uvicorn", "saefr_ml.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--limit-concurrency", "8", "--no-access-log", "--log-level", "warning"]
