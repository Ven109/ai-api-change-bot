# Fixture: shipping-service (Python, `requests`, OpenAPI diff)

A service that talks to the **Parcelio** shipping API with `requests`. Parcelio
is synthetic — a stand-in provider modeled on common shipping-API shapes — but
it publishes an OpenAPI description, which is the interesting part: the upstream
change is detectable **without a model at all**.

What this fixture exercises:

| Piece | Why it is here |
| --- | --- |
| `shipping/client.py` | Three call sites built from a `BASE_URL` constant and f-strings: `GET /v1/shipments/{id}`, `GET /v1/shipments/{id}/track?carrier=…`, `POST /v1/labels`. |
| `shipping/notifications.py` | A second module reading `eta`, so the blast radius is more than one file. |
| `upstream/openapi.v1.json` → `openapi.v2.json` | The upstream release, as a spec diff: the track operation is deprecated in favour of `GET /v2/tracking/{tracking_number}`, `carrier` is renamed to `carrier_code`, and `eta` becomes `estimated_delivery`. |
| Decoys in the same diff | `/v1/returns` gains a required `reason` parameter and `/v2/rates` appears. The repo calls neither, so both must be filtered out. |
| `tests/test_client.py` | `unittest` with a stubbed HTTP client, so nothing needs installing and `validate` has real tests to run. |

`GET /v1/shipments/{id}` and `POST /v1/labels` are unchanged upstream, so they
should never show up in a report.

## Run it by hand

```sh
cd examples/shipping-service
python3 -m unittest discover -s tests -t .   # passes before migrating
node ../../bin/acb scan
```

## Replaying the upstream release

acb diffs the live source against the snapshot in `.acb/specs/`. To reproduce
the release locally:

1. Point the source in `acb.config.json` at `upstream/openapi.v1.json` and run
   `acb check`, which records the baseline and reports nothing.
2. Point it back at `upstream/openapi.v2.json` and run `acb check` again. The
   diff is what a real provider release would look like.

`npm run demo` in the repository root does this for you.
