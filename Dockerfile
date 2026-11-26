FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/

EXPOSE 8000

CMD sh -c "python backend/manage.py migrate && gunicorn --chdir backend --bind 0.0.0.0:${PORT:-8000} config.wsgi:application"
