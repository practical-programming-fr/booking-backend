// Booking reference (PNR) generator. Airline PNRs are 6 characters, A-Z 0-9,
// avoiding visually confusable characters. We never reuse a PNR — a caller
// loops on collision against the database.

const PNR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePnr(): string {
  let pnr = "";
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * PNR_ALPHABET.length);
    pnr += PNR_ALPHABET[idx];
  }
  return pnr;
}

export function isValidPnr(value: string): boolean {
  if (value.length !== 6) {
    return false;
  }
  for (const char of value) {
    if (!PNR_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}
