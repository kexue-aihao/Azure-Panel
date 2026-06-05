import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db
from app.routes import accounts, auth, vms, workflows
from app.worker import workflow_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(_: FastAPI):
    Path("data").mkdir(parents=True, exist_ok=True)
    await init_db()
    workflow_worker.start()
    yield
    await workflow_worker.stop()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(vms.router)
app.include_router(workflows.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str) -> FileResponse:
        if path.startswith("api/"):
            return FileResponse(FRONTEND_DIR / "index.html", status_code=404)
        file_path = FRONTEND_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html")
