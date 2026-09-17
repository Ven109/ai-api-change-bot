# OpenWeather API — what's new

<!--
DEMO FIXTURE. This file stands in for a provider's public changelog page so the
demo runs offline. The One Call 2.5 -> 3.0 retirement is a real change; the
wording and dates here are paraphrased, and the other entries are plausible
filler used to prove that unrelated changes get filtered out. Do not treat it
as authoritative documentation.
-->

## 2026-08-12 — Air Pollution API: new hourly forecast endpoint

`GET /data/2.5/air_pollution/forecast` now returns 96 hours of forecast data
instead of 24. No changes are required for existing integrations; the extra
entries are appended to the `list` array.

## 2026-07-30 — Geocoding API: `limit` default lowered

For `GET /geo/1.0/direct` the default of the `limit` parameter changes from 5 to
1. Pass `limit` explicitly if you rely on receiving several matches.

## 2026-06-15 — One Call API 2.5 is retired: migrate to One Call API 3.0

**Breaking change. Sunset date: 2026-11-30.**

`GET /data/2.5/onecall` and `GET /data/2.5/onecall/timemachine` are deprecated
and will stop serving traffic after **2026-11-30**. Requests made after that
date will return `410 Gone`.

Replace the endpoint with One Call API 3.0:

| Old | New |
| --- | --- |
| `https://api.openweathermap.org/data/2.5/onecall` | `https://api.openweathermap.org/data/3.0/onecall` |
| `https://api.openweathermap.org/data/2.5/onecall/timemachine` | `https://api.openweathermap.org/data/3.0/onecall/timemachine` |

Notes for the migration:

* The query parameters are unchanged: `lat`, `lon`, `exclude`, `units`, `lang`
  and `appid` all behave as before, so an existing query string keeps working.
* The response shape of the `current`, `daily`, `hourly` and `alerts` blocks is
  unchanged.
* One Call API 3.0 is billed through the separate **"One Call by Call"**
  subscription. An API key that only has the free Current Weather plan will get
  `401 Unauthorized` from the 3.0 endpoints, so check the key's subscription
  before deploying.

## 2026-05-02 — Current Weather API: `lang` accepts two more locales

`GET /data/2.5/weather` now accepts `lang=eu` and `lang=gl`. Existing values
are unaffected.
