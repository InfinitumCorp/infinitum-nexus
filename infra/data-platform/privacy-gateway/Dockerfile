# Cumulus privacy gateway: Presidio + Google DP. Linux so Google's DP wheels install.
FROM python:3.12.16-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY cumulus_privacy ./cumulus_privacy

RUN useradd --system --uid 10001 gateway && mkdir -p /var/lib/privacy-gateway && chown gateway /var/lib/privacy-gateway
USER gateway

ENV HOST=0.0.0.0 PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8090/api/v1/health')"
CMD ["python", "-m", "cumulus_privacy.server"]
