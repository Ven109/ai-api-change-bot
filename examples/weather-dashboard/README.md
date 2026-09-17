# Fixture: weather-dashboard (Node, `fetch`, prose changelog)

A small service that reads current conditions and severe weather alerts from
the OpenWeather **One Call API 2.5** using plain `fetch`. No SDK is involved,
so no dependency update could ever warn about this endpoint being retired.

What this fixture exercises:

| Piece | Why it is here |
| --- | --- |
| `src/weather.js`, `src/alerts.js` | Two call sites for the same endpoint, in different files, built from a shared base-URL constant and template strings. A migration must find both. |
| `upstream/openweather-changelog.md` | A **prose** upstream source. There is no machine-readable diff here, so judging relevance needs a model. |
| Decoy entries in that changelog | Air Pollution, Geocoding and Current Weather changes that must be filtered out. |
| `test/weather.test.js` | Tests with an injected `fetch` stub, so `validate` has something real to run offline. |

The expected outcome: acb reports the One Call 2.5 retirement as a high-risk,
dated breaking change affecting both files, and a migration moves both call
sites to `/data/3.0/onecall` while keeping the query parameters and response
mapping intact.

## Run it by hand

```sh
cd examples/weather-dashboard
npm test                  # the fixture's own tests, they pass before migrating
node ../../bin/acb scan
```

The changelog file is a stand-in for the provider's public changelog page: the
retirement itself is real, while the wording, dates and surrounding entries are
paraphrased or invented for the demo.
