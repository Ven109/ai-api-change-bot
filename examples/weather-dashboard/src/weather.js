// Weather lookups for the dashboard.
//
// Uses the OpenWeather "One Call" API over plain fetch. There is no SDK and no
// package version anywhere that could tell us this endpoint is going away,
// which is exactly the case acb is built for.

const OPENWEATHER_BASE_URL = "https://api.openweathermap.org";

/**
 * Current conditions plus the daily forecast for a location.
 *
 * @param {{lat: number, lon: number, units?: string}} where
 * @param {{fetch?: typeof fetch, apiKey?: string}} [deps]
 */
export async function getForecast({ lat, lon, units = "metric" }, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const apiKey = deps.apiKey ?? process.env.OPENWEATHER_API_KEY;

  const url =
    `${OPENWEATHER_BASE_URL}/data/2.5/onecall` +
    `?lat=${lat}&lon=${lon}&exclude=minutely,hourly&units=${units}&appid=${apiKey}`;

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`OpenWeather request failed: ${response.status}`);
  }
  const data = await response.json();

  return {
    timezone: data.timezone,
    current: {
      temp: data.current.temp,
      feelsLike: data.current.feels_like,
      description: data.current.weather?.[0]?.description ?? "",
    },
    daily: (data.daily ?? []).map((day) => ({
      date: new Date(day.dt * 1000).toISOString().slice(0, 10),
      min: day.temp.min,
      max: day.temp.max,
    })),
  };
}

export { OPENWEATHER_BASE_URL };
