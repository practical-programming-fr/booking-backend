import type postgres from "postgres";
import type { CabinCode } from "./types.js";

export type ManifestPassenger = {
  pnr: string;
  bookingStatus: "confirmed" | "awaiting_payment";
  cabin: CabinCode;
  passengerNo: number;
  givenName: string;
  familyName: string;
  seatId: string | null;
  loyaltyNo: string | null;
  loyaltyTier: string | null;
  serviceTags: string[];
  preferences: Record<string, unknown>;
  notes: string | null;
  meal: {
    id: string;
    name: string;
    description: string;
    priceEur: number;
  } | null;
};

export type ManifestEvent = {
  pnr: string;
  eventType: string;
  occurredAt: string;
  actor: string;
  details: Record<string, unknown>;
};

export type FlightManifest = {
  flight: {
    id: string;
    flightNo: string;
    status: string;
    departAt: string;
    arriveAt: string;
    durationMin: number;
    aircraft: {
      code: string;
      model: string;
    };
    from: { iata: string; city: string; country: string; tz: string };
    to: { iata: string; city: string; country: string; tz: string };
  };
  cabins: Array<{
    cabin: CabinCode;
    seatsTotal: number;
    seatsAvailable: number;
    passengers: number;
    heldPassengers: number;
  }>;
  passengers: ManifestPassenger[];
  events: ManifestEvent[];
};

export type FlightBriefing = {
  flight: FlightManifest["flight"];
  load: FlightManifest["cabins"];
  totals: {
    passengers: number;
    confirmedPassengers: number;
    heldPassengers: number;
    vipPassengers: number;
    serviceRecoveryPassengers: number;
    specialAttentionPassengers: number;
  };
  vipPassengers: BriefingPassenger[];
  serviceRecoveryPassengers: BriefingPassenger[];
  specialAttentionPassengers: BriefingPassenger[];
  notableEvents: ManifestEvent[];
  talkingPoints: string[];
};

type BriefingPassenger = {
  pnr: string;
  name: string;
  cabin: CabinCode;
  seatId: string | null;
  loyaltyTier: string | null;
  serviceTags: string[];
  notes: string | null;
};

type FlightRow = {
  id: string;
  flight_no: string;
  status: string;
  depart_at: Date;
  arrive_at: Date;
  duration_min: number;
  aircraft_type: string;
  aircraft_model: string;
  from_iata: string;
  from_city: string;
  from_country: string;
  from_tz: string;
  to_iata: string;
  to_city: string;
  to_country: string;
  to_tz: string;
};

type FareRow = {
  cabin: CabinCode;
  seats_total: number;
  seats_available: number;
};

type PassengerRow = {
  pnr: string;
  booking_status: "confirmed" | "awaiting_payment";
  cabin: CabinCode;
  passenger_no: number;
  given_name: string;
  family_name: string;
  seat_id: string | null;
  loyalty_no: string | null;
  loyalty_tier: string | null;
  service_tags: string[] | null;
  preferences: Record<string, unknown> | null;
  notes: string | null;
  meal_id: string | null;
  meal_name: string | null;
  meal_description: string | null;
  meal_price_eur: number | null;
};

type EventRow = {
  booking_pnr: string;
  event_type: string;
  occurred_at: Date;
  actor: string;
  details: Record<string, unknown> | null;
};

function passengerName(passenger: ManifestPassenger): string {
  return `${passenger.givenName} ${passenger.familyName}`;
}

function toBriefingPassenger(passenger: ManifestPassenger): BriefingPassenger {
  return {
    pnr: passenger.pnr,
    name: passengerName(passenger),
    cabin: passenger.cabin,
    seatId: passenger.seatId,
    loyaltyTier: passenger.loyaltyTier,
    serviceTags: passenger.serviceTags,
    notes: passenger.notes,
  };
}

function hasTag(passenger: ManifestPassenger, tag: string): boolean {
  return passenger.serviceTags.includes(tag);
}

function isVip(passenger: ManifestPassenger): boolean {
  return (
    hasTag(passenger, "vip") ||
    passenger.loyaltyTier === "invite" ||
    passenger.loyaltyTier === "platinum"
  );
}

function needsSpecialAttention(passenger: ManifestPassenger): boolean {
  return passenger.serviceTags.some((tag) =>
    [
      "mobility_assistance",
      "dietary_attention",
      "tight_connection",
      "service_recovery",
      "family_travel",
      "child",
    ].includes(tag),
  );
}

export async function loadFlightManifest(
  sql: postgres.Sql,
  flightId: string,
): Promise<FlightManifest | null> {
  const flightRows = (await sql`
    select f.id, f.flight_no, f.status, f.depart_at, f.arrive_at, f.duration_min,
           f.aircraft_type, at.model as aircraft_model,
           from_air.iata as from_iata, from_air.city as from_city,
           from_air.country as from_country, from_air.tz as from_tz,
           to_air.iata as to_iata, to_air.city as to_city,
           to_air.country as to_country, to_air.tz as to_tz
    from public.flights f
    join public.routes r on r.id = f.route_id
    join public.aircraft_types at on at.code = f.aircraft_type
    join public.airports from_air on from_air.iata = r.from_iata
    join public.airports to_air on to_air.iata = r.to_iata
    where f.id = ${flightId}
  `) as unknown as FlightRow[];

  const flight = flightRows[0];
  if (!flight) {
    return null;
  }

  const fareRows = (await sql`
    select cabin, seats_total, seats_available
    from public.flight_fares
    where flight_id = ${flightId}
    order by cabin
  `) as unknown as FareRow[];

  const passengerRows = (await sql`
    select b.pnr, b.status as booking_status, bs.cabin,
           p.passenger_no, p.given_name, p.family_name, p.seat_id,
           p.loyalty_no, p.loyalty_tier, p.service_tags, p.preferences,
           p.notes, p.meal_id,
           m.name as meal_name, m.description as meal_description,
           m.price_eur as meal_price_eur
    from public.booking_segments bs
    join public.bookings b on b.pnr = bs.booking_pnr
    join public.passengers p on p.booking_pnr = b.pnr
    left join public.meals m on m.id = p.meal_id
    where bs.flight_id = ${flightId}
      and b.status in ('confirmed', 'awaiting_payment')
    order by bs.cabin, p.seat_id nulls last, p.passenger_no
  `) as unknown as PassengerRow[];

  const pnrs = [...new Set(passengerRows.map((row) => row.pnr))];
  const eventRows =
    pnrs.length > 0
      ? ((await sql`
          select booking_pnr, event_type, occurred_at, actor, details
          from public.booking_events
          where booking_pnr in ${sql(pnrs)}
          order by occurred_at asc
        `) as unknown as EventRow[])
      : [];

  const passengers = passengerRows.map<ManifestPassenger>((row) => ({
    pnr: row.pnr,
    bookingStatus: row.booking_status,
    cabin: row.cabin,
    passengerNo: row.passenger_no,
    givenName: row.given_name,
    familyName: row.family_name,
    seatId: row.seat_id,
    loyaltyNo: row.loyalty_no,
    loyaltyTier: row.loyalty_tier,
    serviceTags: row.service_tags ?? [],
    preferences: row.preferences ?? {},
    notes: row.notes,
    meal: row.meal_id && row.meal_name && row.meal_description
      ? {
          id: row.meal_id,
          name: row.meal_name,
          description: row.meal_description,
          priceEur: row.meal_price_eur ?? 0,
        }
      : null,
  }));

  const cabins = fareRows.map((fare) => {
    const cabinPassengers = passengers.filter((passenger) => passenger.cabin === fare.cabin);
    return {
      cabin: fare.cabin,
      seatsTotal: fare.seats_total,
      seatsAvailable: fare.seats_available,
      passengers: cabinPassengers.length,
      heldPassengers: cabinPassengers.filter(
        (passenger) => passenger.bookingStatus === "awaiting_payment",
      ).length,
    };
  });

  return {
    flight: {
      id: flight.id,
      flightNo: flight.flight_no,
      status: flight.status,
      departAt: flight.depart_at.toISOString(),
      arriveAt: flight.arrive_at.toISOString(),
      durationMin: flight.duration_min,
      aircraft: {
        code: flight.aircraft_type,
        model: flight.aircraft_model,
      },
      from: {
        iata: flight.from_iata,
        city: flight.from_city,
        country: flight.from_country,
        tz: flight.from_tz,
      },
      to: {
        iata: flight.to_iata,
        city: flight.to_city,
        country: flight.to_country,
        tz: flight.to_tz,
      },
    },
    cabins,
    passengers,
    events: eventRows.map((row) => ({
      pnr: row.booking_pnr,
      eventType: row.event_type,
      occurredAt: row.occurred_at.toISOString(),
      actor: row.actor,
      details: row.details ?? {},
    })),
  };
}

export async function loadFlightBriefing(
  sql: postgres.Sql,
  flightId: string,
): Promise<FlightBriefing | null> {
  const manifest = await loadFlightManifest(sql, flightId);
  if (!manifest) {
    return null;
  }

  const vipPassengers = manifest.passengers.filter(isVip).map(toBriefingPassenger);
  const serviceRecoveryPassengers = manifest.passengers
    .filter((passenger) => hasTag(passenger, "service_recovery"))
    .map(toBriefingPassenger);
  const specialAttentionPassengers = manifest.passengers
    .filter(needsSpecialAttention)
    .map(toBriefingPassenger);
  const notableEvents = manifest.events.filter((event) =>
    ["flight_disrupted", "rebooked_from", "rebooked_to", "service_recovery_added", "vip_profile_synced"].includes(
      event.eventType,
    ),
  );

  const talkingPoints: string[] = [];
  if (vipPassengers.length > 0) {
    talkingPoints.push(
      `${vipPassengers.length} VIP passenger${vipPassengers.length === 1 ? "" : "s"} onboard.`,
    );
  }
  if (serviceRecoveryPassengers.length > 0) {
    talkingPoints.push("Review service-recovery notes before boarding.");
  }
  if (specialAttentionPassengers.some((passenger) => passenger.serviceTags.includes("dietary_attention"))) {
    talkingPoints.push("Confirm special meal and dietary attention items with cabin crew.");
  }
  if (specialAttentionPassengers.some((passenger) => passenger.serviceTags.includes("tight_connection"))) {
    talkingPoints.push("Monitor tight-connection passengers for arrival support.");
  }

  return {
    flight: manifest.flight,
    load: manifest.cabins,
    totals: {
      passengers: manifest.passengers.length,
      confirmedPassengers: manifest.passengers.filter(
        (passenger) => passenger.bookingStatus === "confirmed",
      ).length,
      heldPassengers: manifest.passengers.filter(
        (passenger) => passenger.bookingStatus === "awaiting_payment",
      ).length,
      vipPassengers: vipPassengers.length,
      serviceRecoveryPassengers: serviceRecoveryPassengers.length,
      specialAttentionPassengers: specialAttentionPassengers.length,
    },
    vipPassengers,
    serviceRecoveryPassengers,
    specialAttentionPassengers,
    notableEvents,
    talkingPoints,
  };
}

