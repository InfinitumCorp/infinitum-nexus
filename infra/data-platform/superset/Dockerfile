# Apache Superset 6.1.0 (Apache-2.0) with the Postgres driver and Cumulus ID sign-in.
FROM apache/superset:6.1.0

USER root
# The lean image has no database drivers. authlib backs the OIDC sign-in.
RUN . /app/.venv/bin/activate && uv pip install --no-cache psycopg2-binary==2.9.11 authlib==1.6.5
COPY superset_config.py /app/pythonpath/superset_config.py
USER superset
