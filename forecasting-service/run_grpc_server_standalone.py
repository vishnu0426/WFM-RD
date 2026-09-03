"""Boots only `ForecastService` (Phase 6, ADR-0059) - not the FastAPI app,
not this service's ML stack. `app/main.py` transitively imports
`torch`/`ray`/`mlflow`/`lightgbm`/`prophet`/`pytorch-forecasting`/`lightning`
just by importing the existing job/model routers; this script needs none of
that to serve real, DB-backed forecast requirements. Useful for local
development against Module 04's scheduling-service (see its README's
"Getting started") without installing the full ML environment, and for
`tests/grpc/`'s own real-server verification of this surface in isolation.

    python run_grpc_server_standalone.py
"""

from __future__ import annotations

import asyncio

import grpc

from app.grpc.forecast_grpc_server import ForecastServicer
from app.grpc.generated import forecast_pb2_grpc


async def main() -> None:
    server = grpc.aio.server()
    forecast_pb2_grpc.add_ForecastServiceServicer_to_server(ForecastServicer(), server)
    server.add_insecure_port("0.0.0.0:6000")
    await server.start()
    print("ForecastService listening on :6000", flush=True)
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(main())
