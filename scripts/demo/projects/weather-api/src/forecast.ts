import { Cache } from './cache';

export interface Forecast {
  city: string;
  days: { date: string; high: number; low: number; summary: string }[];
}

const TEN_MINUTES = 10 * 60 * 1000;
const cache = new Cache<Forecast>(TEN_MINUTES);

function cacheKey(city: string, days: number): string {
  return `${city.toLowerCase()}:${days}`;
}

export async function getForecast(city: string, days = 5): Promise<Forecast> {
  const key = cacheKey(city, days);
  const cached = cache.get(key);
  if (cached) return cached;

  const res = await fetch(`https://api.example.com/forecast?city=${encodeURIComponent(city)}&days=${days}`);
  if (!res.ok) throw new Error(`forecast request failed: ${res.status}`);
  const forecast = (await res.json()) as Forecast;
  cache.set(key, forecast);
  return forecast;
}
