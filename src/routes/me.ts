import { Hono } from "hono";
import { z } from "zod";
import { getSql } from "../db/client.js";
import { loadEnv } from "../env.js";

const sessionIdSchema = z.string().uuid();

export function meRoutes(): Hono {
  const app = new Hono();

  app.get("/trips", async (c) => {
    const env = loadEnv();
    const headerName = env.BOOKING_SESSION_HEADER.toLowerCase();
    const raw = c.req.header(headerName);
    const parsed = raw ? sessionIdSchema.safeParse(raw) : null;
    if (!parsed || !parsed.success) {
      return c.json({ trips: [] });
    }

    const sql = getSql();
    const rows = (await sql`
      select b.pnr,
             b.status,
             b.pax,
             b.total_eur,
             b.contact,
             b.created_at,
             b.confirmed_at,
             b.cancelled_at,
             bs.cabin,
             f.flight_no,
             f.depart_at,
             f.arrive_at,
             f.duration_min,
             r.from_iata,
             from_air.city as from_city,
             r.to_iata,
             to_air.city as to_city
      from public.bookings b
      left join lateral (
        select bs.cabin, bs.flight_id
        from public.booking_segments bs
        where bs.booking_pnr = b.pnr
        order by bs.segment_no asc
        limit 1
      ) bs on true
      left join public.flights f on f.id = bs.flight_id
      left join public.routes r on r.id = f.route_id
      left join public.airports from_air on from_air.iata = r.from_iata
      left join public.airports to_air on to_air.iata = r.to_iata
      where b.session_id = ${parsed.data}
      order by b.created_at desc
      limit 50
    `) as unknown as Array<{
      pnr: string;
      status: string;
      pax: number;
      total_eur: number;
      contact: { name?: string; email?: string } | null;
      created_at: Date;
      confirmed_at: Date | null;
      cancelled_at: Date | null;
      cabin: string | null;
      flight_no: string | null;
      depart_at: Date | null;
      arrive_at: Date | null;
      duration_min: number | null;
      from_iata: string | null;
      from_city: string | null;
      to_iata: string | null;
      to_city: string | null;
    }>;

    return c.json({
      trips: rows.map((row) => ({
        pnr: row.pnr,
        status: row.status,
        pax: row.pax,
        totalEur: row.total_eur,
        contact: row.contact ?? {},
        createdAt: row.created_at.toISOString(),
        confirmedAt: row.confirmed_at?.toISOString() ?? null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null,
        segment: row.flight_no && row.depart_at && row.arrive_at && row.cabin
          ? {
              flightNo: row.flight_no,
              cabin: row.cabin,
              departAt: row.depart_at.toISOString(),
              arriveAt: row.arrive_at.toISOString(),
              durationMin: row.duration_min ?? 0,
              from: { iata: row.from_iata ?? "", city: row.from_city ?? "" },
              to: { iata: row.to_iata ?? "", city: row.to_city ?? "" },
            }
          : null,
      })),
    });
  });

  return app;
}
