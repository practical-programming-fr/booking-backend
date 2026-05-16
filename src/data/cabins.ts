// Mirrors the marketing site's three cabin classes. The multiplier is applied
// against the route's `fare_from_eur` to compute the per-flight cabin base
// fare, then jittered per flight to make calendars and search results feel
// like real inventory.

export type SeedCabin = {
  code: "A" | "P" | "L";
  name: string;
  multiplier: number;
  deck: string;
  dining: string;
  sortOrder: number;
};

export const cabins: SeedCabin[] = [
  {
    code: "A",
    name: "Atlas Suite",
    multiplier: 4.6,
    deck: "Upper deck private suites",
    dining: "Atelier service included",
    sortOrder: 1,
  },
  {
    code: "P",
    name: "Prospect",
    multiplier: 1.8,
    deck: "Forward cabin with extra pitch",
    dining: "Curated meal selection",
    sortOrder: 2,
  },
  {
    code: "L",
    name: "Linen",
    multiplier: 1,
    deck: "Main cabin studio seats",
    dining: "Comfort menu and upgrades",
    sortOrder: 3,
  },
];
