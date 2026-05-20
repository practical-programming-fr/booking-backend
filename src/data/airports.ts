// Canonical airport catalog. Mirrors the marketing site (flylo-air/web) plus
// extra metadata (timezone, hub flag) that we need server-side. Two hubs:
// London Heathrow and San Francisco. All other airports are spokes for now.

export type SeedAirport = {
  iata: string;
  icao: string;
  city: string;
  country: string;
  continent:
    | "Africa"
    | "Asia"
    | "Europe"
    | "North America"
    | "Oceania"
    | "South America";
  lat: number;
  lon: number;
  tz: string;
  isHub: boolean;
};

export const airports: SeedAirport[] = [
  // Hubs
  { iata: "LHR", icao: "EGLL", city: "London",       country: "United Kingdom", continent: "Europe",        lat: 51.47,  lon:  -0.45,  tz: "Europe/London",      isHub: true },
  { iata: "SFO", icao: "KSFO", city: "San Francisco", country: "United States",  continent: "North America", lat: 37.62,  lon: -122.37, tz: "America/Los_Angeles", isHub: true },

  // Short haul (Europe / N. Africa / Middle East)
  { iata: "CDG", icao: "LFPG", city: "Paris",        country: "France",         continent: "Europe", lat: 49.00, lon:   2.55, tz: "Europe/Paris",       isHub: false },
  { iata: "AMS", icao: "EHAM", city: "Amsterdam",    country: "Netherlands",    continent: "Europe", lat: 52.30, lon:   4.76, tz: "Europe/Amsterdam",   isHub: false },
  { iata: "BCN", icao: "LEBL", city: "Barcelona",    country: "Spain",          continent: "Europe", lat: 41.30, lon:   2.08, tz: "Europe/Madrid",      isHub: false },
  { iata: "CPH", icao: "EKCH", city: "Copenhagen",   country: "Denmark",        continent: "Europe", lat: 55.60, lon:  12.65, tz: "Europe/Copenhagen",  isHub: false },
  { iata: "FCO", icao: "LIRF", city: "Rome",         country: "Italy",          continent: "Europe", lat: 41.80, lon:  12.25, tz: "Europe/Rome",        isHub: false },
  { iata: "LIS", icao: "LPPT", city: "Lisbon",       country: "Portugal",       continent: "Europe", lat: 38.80, lon:  -9.13, tz: "Europe/Lisbon",      isHub: false },
  { iata: "IST", icao: "LTFM", city: "Istanbul",     country: "Türkiye",        continent: "Europe", lat: 41.30, lon:  28.74, tz: "Europe/Istanbul",    isHub: false },
  { iata: "ATH", icao: "LGAV", city: "Athens",       country: "Greece",         continent: "Europe", lat: 37.90, lon:  23.95, tz: "Europe/Athens",      isHub: false },

  // Long haul
  { iata: "JFK", icao: "KJFK", city: "New York",     country: "United States",  continent: "North America", lat: 40.64, lon: -73.78,  tz: "America/New_York",     isHub: false },
  { iata: "HND", icao: "RJTT", city: "Tokyo",        country: "Japan",          continent: "Asia",          lat: 35.55, lon: 139.78,  tz: "Asia/Tokyo",            isHub: false },
  { iata: "SIN", icao: "WSSS", city: "Singapore",    country: "Singapore",      continent: "Asia",          lat:  1.36, lon: 103.99,  tz: "Asia/Singapore",        isHub: false },
  { iata: "DXB", icao: "OMDB", city: "Dubai",        country: "UAE",            continent: "Asia",          lat: 25.25, lon:  55.36,  tz: "Asia/Dubai",            isHub: false },
  { iata: "GRU", icao: "SBGR", city: "São Paulo",    country: "Brazil",         continent: "South America", lat: -23.43, lon: -46.48, tz: "America/Sao_Paulo",     isHub: false },
  { iata: "SYD", icao: "YSSY", city: "Sydney",       country: "Australia",      continent: "Oceania",       lat: -33.95, lon: 151.18, tz: "Australia/Sydney",      isHub: false },
  { iata: "JNB", icao: "FAOR", city: "Johannesburg", country: "South Africa",   continent: "Africa",        lat: -26.14, lon:  28.24, tz: "Africa/Johannesburg",   isHub: false },
];
