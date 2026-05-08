/**
 * Typed wrapper around The Odds API for sportsbook odds.
 *
 * All sportsbook data flows through fetchOdds().
 * Strategy code never makes raw HTTP calls to The Odds API.
 */

/** Raw outcome shape from The Odds API response. */
interface ApiOutcome {
  name: string;
  price: number;
  point?: number;
}

/** Raw market shape from The Odds API response. */
interface ApiMarket {
  key: string;
  outcomes: ApiOutcome[];
}

/** Raw bookmaker shape from The Odds API response. */
interface ApiBookmaker {
  key: string;
  title: string;
  markets: ApiMarket[];
}

/** Raw event shape from The Odds API response. */
interface ApiEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: ApiBookmaker[];
}

/** A single outcome line from a bookmaker. */
export interface BookmakerOutcome {
  name: string;
  price: number;
  point?: number;
}

/** A market type offering from a bookmaker. */
export interface BookmakerMarket {
  key: string;
  outcomes: BookmakerOutcome[];
}

/** A sportsbook with its market offerings. */
export interface Bookmaker {
  key: string;
  title: string;
  markets: BookmakerMarket[];
}

/** A sporting event with bookmaker odds. */
export interface SportEvent {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commence: Date;
  bookmakers: Bookmaker[];
}

const BASE_URL = "https://api.the-odds-api.com/v4/sports";

function getApiKey(): string {
  const key = process.env["THE_ODDS_API_KEY"];
  if (!key) {
    throw new Error(
      "THE_ODDS_API_KEY is not set. " +
        "Get a free key at https://the-odds-api.com/ " +
        "and add it to your .env file.",
    );
  }
  return key;
}

function mapOutcome(raw: ApiOutcome): BookmakerOutcome {
  return {
    name: raw.name,
    price: raw.price,
    ...(raw.point !== undefined ? { point: raw.point } : {}),
  };
}

function mapMarket(raw: ApiMarket): BookmakerMarket {
  return {
    key: raw.key,
    outcomes: raw.outcomes.map(mapOutcome),
  };
}

function mapBookmaker(raw: ApiBookmaker): Bookmaker {
  return {
    key: raw.key,
    title: raw.title,
    markets: raw.markets.map(mapMarket),
  };
}

function mapEvent(raw: ApiEvent): SportEvent {
  return {
    id: raw.id,
    homeTeam: raw.home_team,
    awayTeam: raw.away_team,
    commence: new Date(raw.commence_time),
    bookmakers: raw.bookmakers.map(mapBookmaker),
  };
}

/**
 * Fetch upcoming event odds from The Odds API.
 *
 * @param sport - Sport key (e.g. "basketball_nba", "basketball_nba_championship_winner").
 * @param eventId - Optional event ID to fetch odds for a single event.
 * @returns Array of sporting events with bookmaker odds.
 */
export async function fetchOdds(
  sport: string,
  eventId?: string,
): Promise<SportEvent[]> {
  const apiKey = getApiKey();

  const path = eventId
    ? `${BASE_URL}/${sport}/events/${eventId}/odds`
    : `${BASE_URL}/${sport}/odds`;

  const url = new URL(path);
  // Championship/winner markets use "outrights"; game markets use "h2h"
  const marketType = sport.includes("_winner") ? "outrights" : "h2h";

  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", marketType);

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `The Odds API error (${String(response.status)}): ${body}`,
    );
  }

  const data: unknown = await response.json();

  // Single-event endpoint returns one object; list endpoint returns an array.
  const events: ApiEvent[] = Array.isArray(data)
    ? (data as ApiEvent[])
    : [data as ApiEvent];

  return events.map(mapEvent);
}
