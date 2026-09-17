import unittest

from shipping.client import create_label, get_shipment, track_shipment
from shipping.notifications import delivery_notice


class Response:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")


class StubHttp:
    """Records requests and replies with canned payloads."""

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("GET", url, params or {}))
        return Response(self.payload)

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(("POST", url, json or {}))
        return Response(self.payload)


class GetShipmentTest(unittest.TestCase):
    def test_requests_the_shipment_by_id(self):
        http = StubHttp({"id": "shp_1", "state": "in_transit"})

        shipment = get_shipment("shp_1", http=http)

        method, url, _ = http.calls[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, "https://api.parcelio.test/v1/shipments/shp_1")
        self.assertEqual(shipment["state"], "in_transit")


class TrackShipmentTest(unittest.TestCase):
    def test_sends_the_carrier_and_maps_the_payload(self):
        http = StubHttp(
            {
                "status": "in_transit",
                "eta": "2026-09-21",
                "checkpoints": [{"at": "2026-09-18T08:00:00Z", "location": "Berlin"}],
            }
        )

        tracking = track_shipment("shp_1", "dhl", http=http)

        method, url, params = http.calls[0]
        self.assertEqual(method, "GET")
        self.assertEqual(url, "https://api.parcelio.test/v1/shipments/shp_1/track")
        self.assertEqual(params, {"carrier": "dhl"})
        self.assertEqual(tracking["status"], "in_transit")
        self.assertEqual(tracking["eta"], "2026-09-21")
        self.assertEqual(len(tracking["checkpoints"]), 1)


class CreateLabelTest(unittest.TestCase):
    def test_posts_the_label_request(self):
        http = StubHttp({"label_url": "https://cdn.parcelio.test/labels/1.pdf"})

        url = create_label("shp_1", 1200, http=http)

        method, endpoint, body = http.calls[0]
        self.assertEqual(method, "POST")
        self.assertEqual(endpoint, "https://api.parcelio.test/v1/labels")
        self.assertEqual(body, {"shipment_id": "shp_1", "weight_grams": 1200})
        self.assertEqual(url, "https://cdn.parcelio.test/labels/1.pdf")


class DeliveryNoticeTest(unittest.TestCase):
    def test_mentions_the_arrival_date_while_in_transit(self):
        http = StubHttp({"status": "in_transit", "eta": "2026-09-21"})

        notice = delivery_notice("shp_1", "dhl", http=http)

        self.assertEqual(notice, "Your parcel is in_transit, arriving 2026-09-21.")

    def test_short_message_once_delivered(self):
        http = StubHttp({"status": "delivered", "eta": "2026-09-20"})

        self.assertEqual(delivery_notice("shp_1", "dhl", http=http), "Your parcel has been delivered.")


if __name__ == "__main__":
    unittest.main()
