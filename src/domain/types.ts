// Shared shapes for the booking domain. The routes layer maps DB rows to
// these structures before serializing to JSON.

export type CabinCode = "A" | "P" | "L";

export type BookingTotals = {
  baseEur: number;
  seatsEur: number;
  mealsEur: number;
  taxesEur: number;
  surfaceEur: number;
  discountEur: number;
  totalEur: number;
};

export type PassengerView = {
  passengerNo: number;
  givenName: string;
  familyName: string;
  loyaltyNo: string | null;
  notes: string | null;
  seatId: string | null;
  mealId: string | null;
};

export type ContactDetails = {
  name?: string;
  email?: string;
  phone?: string;
};

export type SegmentView = {
  segmentNo: number;
  flightId: string;
  cabin: CabinCode;
  flightNo: string;
  departAt: string;
  arriveAt: string;
  durationMin: number;
  aircraft: string;
  from: { iata: string; city: string; country: string; tz: string };
  to: { iata: string; city: string; country: string; tz: string };
};

export type PaymentView = {
  id: string;
  provider: "mock" | "stripe_test";
  status: "pending" | "succeeded" | "failed" | "refunded";
  amountEur: number;
  cardholder: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type BookingView = {
  pnr: string;
  status: "draft" | "awaiting_payment" | "confirmed" | "cancelled";
  contact: ContactDetails;
  pax: number;
  currency: "EUR";
  promoCode: string | null;
  totals: BookingTotals;
  holdExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  segments: SegmentView[];
  passengers: PassengerView[];
  payments: PaymentView[];
};
