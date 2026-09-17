"""Client for the Parcelio shipping API.

Plain HTTP calls with ``requests``. The endpoints, query parameters and
response fields used here are what acb has to line up against the provider's
OpenAPI description.

The ``http`` argument exists so the tests can pass a stub; it also means this
module imports cleanly in an environment without ``requests`` installed, which
keeps the demo dependency-free.
"""

from __future__ import annotations

import os
from typing import Any

try:  # pragma: no cover - the demo runs without third-party packages
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]

BASE_URL = "https://api.parcelio.test"
TIMEOUT_SECONDS = 10


def _http(http: Any = None) -> Any:
    client = http or requests
    if client is None:  # pragma: no cover
        raise RuntimeError("requests is not installed; pass an http client explicitly")
    return client


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {os.environ.get('PARCELIO_API_KEY', '')}",
        "Accept": "application/json",
    }


def get_shipment(shipment_id: str, http: Any = None) -> dict[str, Any]:
    """Fetch a single shipment."""
    response = _http(http).get(
        f"{BASE_URL}/v1/shipments/{shipment_id}",
        headers=_headers(),
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.json()


def track_shipment(shipment_id: str, carrier: str, http: Any = None) -> dict[str, Any]:
    """Current tracking state for a shipment, as shown on the order page."""
    response = _http(http).get(
        f"{BASE_URL}/v1/shipments/{shipment_id}/track",
        params={"carrier": carrier},
        headers=_headers(),
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    return {
        "status": payload["status"],
        "eta": payload["eta"],
        "checkpoints": payload.get("checkpoints", []),
    }


def create_label(shipment_id: str, weight_grams: int, http: Any = None) -> str:
    """Buy a shipping label and return its PDF URL."""
    response = _http(http).post(
        f"{BASE_URL}/v1/labels",
        json={"shipment_id": shipment_id, "weight_grams": weight_grams},
        headers=_headers(),
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response.json()["label_url"]
