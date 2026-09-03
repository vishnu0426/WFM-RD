"""§3.3's `POST /v1/forecasting/scenarios` + a poll endpoint, matching
§3.2's `runScenarioSimulation` mutation contract (returns immediately -
`status: queued` in the general async-job sense, though this phase's
implementation always resolves to `completed`/`failed` before the response
is even sent, ADR-0024)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import CreateScenarioRequest, ScenarioSimulationResponse
from app.core.tenant_context import TenantContext
from app.db.models import ScenarioSimulation
from app.events import nats_publisher
from app.ml.scenario import AssumptionOverrides
from app.services import scenario_service

router = APIRouter(prefix="/v1/forecasting/scenarios", tags=["forecasting-scenarios"])


def _to_response(scenario: ScenarioSimulation) -> ScenarioSimulationResponse:
    return ScenarioSimulationResponse(
        id=scenario.id,
        base_forecast_run_id=scenario.base_forecast_run_id,
        assumption_overrides=scenario.assumption_overrides,
        result_forecast_run_id=scenario.result_forecast_run_id,
        status=scenario.status,
    )


@router.post("", response_model=ScenarioSimulationResponse, status_code=201)
async def create_scenario(
    body: CreateScenarioRequest,
    request: Request,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScenarioSimulationResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    overrides = AssumptionOverrides(
        volume_multiplier=float(body.assumption_overrides.volume_multiplier),
        aht_delta_seconds=float(body.assumption_overrides.aht_delta_seconds),
        shrinkage_delta_pct=float(body.assumption_overrides.shrinkage_delta_pct),
    )
    scenario, result_run = await scenario_service.create_scenario(
        session,
        tenant_id=tenant_id,
        base_forecast_run_id=body.base_forecast_run_id,
        overrides=overrides,
        assumption_overrides_raw=body.assumption_overrides.model_dump(mode="json", by_alias=True),
    )

    # ADR-0024, Decision 4 - the result run gets the same completion event a
    # live forecast job does. Always true in this phase (scenarios always
    # resolve to `completed` synchronously), but checked explicitly rather
    # than assumed, matching `job_service`'s own posture.
    if scenario.status == "completed":
        await nats_publisher.publish_run_completed(
            request.app.state.jetstream,
            tenant_id=tenant_id,
            forecast_run_id=result_run.id,
            org_unit_id=result_run.org_unit_id,
            status="completed",
        )

    return _to_response(scenario)


@router.get("/{scenario_id}", response_model=ScenarioSimulationResponse)
async def get_scenario(
    scenario_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScenarioSimulationResponse:
    scenario = await scenario_service.get_scenario(
        session, tenant_id=uuid.UUID(context.tenant_id), scenario_id=scenario_id
    )
    return _to_response(scenario)
