// Severe weather alerts.
//
// A second call site for the same upstream endpoint, in a different file and
// with a different `exclude` set. A migration has to find both.

import { OPENWEATHER_BASE_URL } from "./weather.js";

/**
 * @param {{lat: number, lon: number}} where
 * @param {{fetch?: typeof fetch, apiKey?: string}} [deps]
 */
export async function getActiveAlerts({ lat, lon }, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const apiKey = deps.apiKey ?? process.env.OPENWEATHER_API_KEY;

  const url =
    `${OPENWEATHER_BASE_URL}/data/2.5/onecall` +
    `?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily&appid=${apiKey}`;

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`OpenWeather request failed: ${response.status}`);
  }
  const data = await response.json();

  return (data.alerts ?? []).map((alert) => ({
    event: alert.event,
    sender: alert.sender_name,
    start: new Date(alert.start * 1000).toISOString(),
    end: new Date(alert.end * 1000).toISOString(),
  }));
}
