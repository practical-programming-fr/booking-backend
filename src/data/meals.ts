// Ported from flylo-air/web/src/app/book/BookingForm.tsx.

export type SeedMeal = {
  id: string;
  name: string;
  description: string;
  priceEur: number;
  cabins: Array<"A" | "P" | "L">;
  sortOrder: number;
};

export const meals: SeedMeal[] = [
  {
    id: "seasonal",
    name: "Seasonal service",
    description: "Rotating regional menu, warm bread, and dessert course.",
    priceEur: 0,
    cabins: ["A", "P", "L"],
    sortOrder: 1,
  },
  {
    id: "plant-forward",
    name: "Plant-forward",
    description: "Vegetable-led plates with citrus grains and tea pairing.",
    priceEur: 0,
    cabins: ["A", "P", "L"],
    sortOrder: 2,
  },
  {
    id: "linen-comfort",
    name: "Comfort tray",
    description: "Bowl, fresh fruit, chocolate sable, and still water set.",
    priceEur: 14,
    cabins: ["P", "L"],
    sortOrder: 3,
  },
  {
    id: "atelier-tasting",
    name: "Atelier tasting",
    description: "Five-course chef menu with lounge pantry access.",
    priceEur: 36,
    cabins: ["A", "P"],
    sortOrder: 4,
  },
  {
    id: "sleep-service",
    name: "Sleep service",
    description: "Light supper, herbal tonic, and wake-up espresso pairing.",
    priceEur: 18,
    cabins: ["A", "P", "L"],
    sortOrder: 5,
  },
];
