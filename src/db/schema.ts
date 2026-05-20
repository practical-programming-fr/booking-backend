// Drizzle schema. Hand-written to match `supabase/migrations/*.sql` — the
// migrations are the source of truth, this file just gives us typed queries.

import {
  bigint,
  bigserial,
  boolean,
  char,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const airports = pgTable("airports", {
  iata: char("iata", { length: 3 }).primaryKey(),
  icao: char("icao", { length: 4 }),
  city: text("city").notNull(),
  country: text("country").notNull(),
  continent: text("continent").notNull(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  tz: text("tz").notNull(),
  isHub: boolean("is_hub").notNull().default(false),
});

export const aircraftTypes = pgTable("aircraft_types", {
  code: text("code").primaryKey(),
  model: text("model").notNull(),
  seats: integer("seats").notNull(),
  rangeKm: integer("range_km").notNull(),
  cruiseKmh: integer("cruise_kmh").notNull(),
  introducedYear: integer("introduced_year"),
  role: text("role").notNull(),
  note: text("note"),
});

export const cabins = pgTable("cabins", {
  code: char("code", { length: 1 }).primaryKey(),
  name: text("name").notNull(),
  multiplier: numeric("multiplier", { precision: 4, scale: 2 }).notNull(),
  deck: text("deck"),
  dining: text("dining"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const seatMapTemplates = pgTable(
  "seat_map_templates",
  {
    aircraftType: text("aircraft_type").notNull(),
    cabin: char("cabin", { length: 1 }).notNull(),
    layout: jsonb("layout").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.aircraftType, table.cabin] }),
  }),
);

export const meals = pgTable("meals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  priceEur: integer("price_eur").notNull().default(0),
  cabins: text("cabins").array().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const routes = pgTable("routes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  fromIata: char("from_iata", { length: 3 }).notNull(),
  toIata: char("to_iata", { length: 3 }).notNull(),
  durationMin: integer("duration_min").notNull(),
  fareFromEur: integer("fare_from_eur").notNull(),
  freqPerWeek: integer("freq_per_week").notNull(),
  haul: text("haul").notNull(),
  defaultAircraft: text("default_aircraft").notNull(),
});

export const flights = pgTable("flights", {
  id: uuid("id").primaryKey().defaultRandom(),
  flightNo: text("flight_no").notNull(),
  routeId: bigint("route_id", { mode: "number" }).notNull(),
  aircraftType: text("aircraft_type").notNull(),
  departAt: timestamp("depart_at", { withTimezone: true }).notNull(),
  arriveAt: timestamp("arrive_at", { withTimezone: true }).notNull(),
  durationMin: integer("duration_min").notNull(),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flightFares = pgTable(
  "flight_fares",
  {
    flightId: uuid("flight_id").notNull(),
    cabin: char("cabin", { length: 1 }).notNull(),
    baseEur: integer("base_eur").notNull(),
    taxesEur: integer("taxes_eur").notNull().default(0),
    surfaceEur: integer("surface_eur").notNull().default(0),
    seatsTotal: integer("seats_total").notNull(),
    seatsAvailable: integer("seats_available").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.flightId, table.cabin] }),
  }),
);

export const flightSeats = pgTable(
  "flight_seats",
  {
    flightId: uuid("flight_id").notNull(),
    seatId: text("seat_id").notNull(),
    cabin: char("cabin", { length: 1 }).notNull(),
    zone: text("zone").notNull(),
    priceEur: integer("price_eur").notNull().default(0),
    status: text("status").notNull().default("available"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.flightId, table.seatId] }),
  }),
);

export const seatHolds = pgTable("seat_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  flightId: uuid("flight_id").notNull(),
  seatId: text("seat_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  bookingId: uuid("booking_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookings = pgTable("bookings", {
  pnr: char("pnr", { length: 6 }).primaryKey(),
  sessionId: uuid("session_id").notNull(),
  userId: uuid("user_id"),
  status: text("status").notNull().default("draft"),
  contact: jsonb("contact").notNull().default({}),
  currency: char("currency", { length: 3 }).notNull().default("EUR"),
  pax: integer("pax").notNull(),
  baseEur: integer("base_eur").notNull().default(0),
  seatsEur: integer("seats_eur").notNull().default(0),
  mealsEur: integer("meals_eur").notNull().default(0),
  taxesEur: integer("taxes_eur").notNull().default(0),
  surfaceEur: integer("surface_eur").notNull().default(0),
  totalEur: integer("total_eur").notNull().default(0),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
});

export const bookingSegments = pgTable("booking_segments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  bookingPnr: char("booking_pnr", { length: 6 }).notNull(),
  flightId: uuid("flight_id").notNull(),
  cabin: char("cabin", { length: 1 }).notNull(),
  segmentNo: integer("segment_no").notNull().default(1),
});

export const passengers = pgTable("passengers", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  bookingPnr: char("booking_pnr", { length: 6 }).notNull(),
  passengerNo: integer("passenger_no").notNull(),
  givenName: text("given_name").notNull(),
  familyName: text("family_name").notNull(),
  loyaltyNo: text("loyalty_no"),
  notes: text("notes"),
  seatId: text("seat_id"),
  mealId: text("meal_id"),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingPnr: char("booking_pnr", { length: 6 }).notNull(),
  provider: text("provider").notNull().default("mock"),
  status: text("status").notNull().default("pending"),
  amountEur: integer("amount_eur").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("EUR"),
  cardholder: text("cardholder"),
  cardLast4: char("card_last4", { length: 4 }),
  cardBrand: text("card_brand"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
