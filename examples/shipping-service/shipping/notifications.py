"""Customer-facing delivery notifications.

A second consumer of the tracking call, so a migration has to touch more than
one module.
"""

from __future__ import annotations

from typing import Any

from .client import track_shipment


def delivery_notice(shipment_id: str, carrier: str, http: Any = None) -> str:
    """One line of copy for the "where is my parcel" email."""
    tracking = track_shipment(shipment_id, carrier, http=http)
    if tracking["status"] == "delivered":
        return "Your parcel has been delivered."
    return f"Your parcel is {tracking['status']}, arriving {tracking['eta']}."
