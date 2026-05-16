// Seat-map templates per (aircraft_type, cabin). Stored as JSON arrays of row
// definitions in `seat_map_templates.layout`. The seed script expands these
// into one `flight_seats` row per seat per flight.
//
// The shape is deliberately compact — a Linen row "12: A B C D E F" is six
// seats with the row's base price and zone. Atlas Suite has just A/D
// columns because the upper deck is 1-1. Prospect is 4-abreast in two
// pairs (A C D F).

export type SeedSeatRow = {
  row: number;
  columns: string[];
  zone: string;
  priceEur: number;
};

export type SeedSeatTemplate = {
  aircraftType: string;
  cabin: "A" | "P" | "L";
  rows: SeedSeatRow[];
};

// Atlas Suite (upper-deck 1-1). Rows 1-5, columns A & D.
function atlasRows(): SeedSeatRow[] {
  return [
    { row: 1, columns: ["A", "D"], zone: "Front suite",  priceEur: 85 },
    { row: 2, columns: ["A", "D"], zone: "Quiet suite",  priceEur: 35 },
    { row: 3, columns: ["A", "D"], zone: "Window suite", priceEur:  0 },
    { row: 4, columns: ["A", "D"], zone: "Studio suite", priceEur:  0 },
    { row: 5, columns: ["A", "D"], zone: "Rear suite",   priceEur:  0 },
  ];
}

// Prospect (2-2-2). Columns A C D F across rows 6-9.
function prospectRows(): SeedSeatRow[] {
  return [
    { row: 6, columns: ["A", "C", "D", "F"], zone: "Bulkhead",     priceEur: 55 },
    { row: 7, columns: ["A", "C", "D", "F"], zone: "Extra pitch",  priceEur: 25 },
    { row: 8, columns: ["A", "C", "D", "F"], zone: "Window row",   priceEur:  0 },
    { row: 9, columns: ["A", "C", "D", "F"], zone: "Quiet row",    priceEur:  0 },
  ];
}

// Linen (3-3). Rows 12-15, columns A B C D E F.
function linenRows(): SeedSeatRow[] {
  return [
    { row: 12, columns: ["A", "B", "C", "D", "E", "F"], zone: "Forward window",  priceEur: 45 },
    { row: 13, columns: ["A", "B", "C", "D", "E", "F"], zone: "Window row",      priceEur: 10 },
    { row: 14, columns: ["A", "B", "C", "D", "E", "F"], zone: "Aisle row",       priceEur:  0 },
    { row: 15, columns: ["A", "B", "C", "D", "E", "F"], zone: "Rear window",     priceEur:  0 },
  ];
}

// Single-aisle aircraft don't have an Atlas Suite. For simplicity the seed
// uses the same Prospect+Linen layout across A220 and A321XLR. Both A350
// variants get all three cabins.
export const seatTemplates: SeedSeatTemplate[] = [
  // A220-300
  { aircraftType: "A220",     cabin: "P", rows: prospectRows() },
  { aircraftType: "A220",     cabin: "L", rows: linenRows() },

  // A321XLR
  { aircraftType: "A321XLR",  cabin: "P", rows: prospectRows() },
  { aircraftType: "A321XLR",  cabin: "L", rows: linenRows() },

  // A350-900
  { aircraftType: "A350-900", cabin: "A", rows: atlasRows() },
  { aircraftType: "A350-900", cabin: "P", rows: prospectRows() },
  { aircraftType: "A350-900", cabin: "L", rows: linenRows() },

  // A350-1000
  { aircraftType: "A350-1000", cabin: "A", rows: atlasRows() },
  { aircraftType: "A350-1000", cabin: "P", rows: prospectRows() },
  { aircraftType: "A350-1000", cabin: "L", rows: linenRows() },
];

export function flatSeats(rows: SeedSeatRow[]): Array<{
  seatId: string;
  zone: string;
  priceEur: number;
}> {
  return rows.flatMap((row) =>
    row.columns.map((col) => ({
      seatId: `${row.row}${col}`,
      zone: row.zone,
      priceEur: row.priceEur,
    })),
  );
}
