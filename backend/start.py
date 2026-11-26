"""Production entry point: run migrations, then start Gunicorn.

Railway/Nixpacks sometimes execute the start command without shell
operator support, so both steps live in one Python process launch.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")

subprocess.check_call([sys.executable, os.path.join(BACKEND, "manage.py"), "migrate"], cwd=ROOT)

port = os.environ.get("PORT", "8000")
os.chdir(BACKEND)
os.execvp(
    sys.executable,
    [sys.executable, "-m", "gunicorn", "--bind", f"0.0.0.0:{port}", "config.wsgi:application"],
)
