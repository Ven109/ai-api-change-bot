"""Demo fixture: a service integrating with the Parcelio shipping API."""

from .client import create_label, get_shipment, track_shipment
from .notifications import delivery_notice

__all__ = ["create_label", "get_shipment", "track_shipment", "delivery_notice"]
