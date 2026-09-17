import assert from "node:assert/strict";
import test from "node:test";
import { getForecast } from "../src/weather.js";
import { getActiveAlerts } from "../src/alerts.js";

/** Records the requested URL and replies with a canned One Call payload. */
function stubFetch(payload) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchImpl, calls };
}

const FORECAST_PAYLOAD = {
  timezone: "Europe/Berlin",
  current: { temp: 18.4, feels_like: 17.9, weather: [{ description: "light rain" }] },
  daily: [{ dt: 1_726_531_200, temp: { min: 12.1, max: 21.7 } }],
};

test("getForecast maps the One Call payload", async () => {
  const { fetchImpl, calls } = stubFetch(FORECAST_PAYLOAD);

  const result = await getForecast(
    { lat: 52.52, lon: 13.405 },
    { fetch: fetchImpl, apiKey: "test-key" },
  );

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.host, "api.openweathermap.org");
  assert.equal(url.searchParams.get("lat"), "52.52");
  assert.equal(url.searchParams.get("units"), "metric");
  assert.equal(url.searchParams.get("appid"), "test-key");

  assert.equal(result.timezone, "Europe/Berlin");
  assert.equal(result.current.temp, 18.4);
  assert.equal(result.current.feelsLike, 17.9);
  assert.equal(result.current.description, "light rain");
  assert.deepEqual(result.daily, [{ date: "2024-09-17", min: 12.1, max: 21.7 }]);
});

test("getForecast surfaces upstream errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () => getForecast({ lat: 1, lon: 2 }, { fetch: fetchImpl, apiKey: "k" }),
    /failed: 401/,
  );
});

test("getActiveAlerts maps alerts and excludes the daily block", async () => {
  const { fetchImpl, calls } = stubFetch({
    alerts: [
      {
        event: "Severe Thunderstorm Warning",
        sender_name: "DWD",
        start: 1_726_531_200,
        end: 1_726_545_600,
      },
    ],
  });

  const alerts = await getActiveAlerts(
    { lat: 52.52, lon: 13.405 },
    { fetch: fetchImpl, apiKey: "test-key" },
  );

  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get("exclude"), "minutely,hourly,daily");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "Severe Thunderstorm Warning");
  assert.equal(alerts[0].sender, "DWD");
});

test("getActiveAlerts tolerates a payload without alerts", async () => {
  const { fetchImpl } = stubFetch({});
  const alerts = await getActiveAlerts({ lat: 1, lon: 2 }, { fetch: fetchImpl, apiKey: "k" });
  assert.deepEqual(alerts, []);
});
