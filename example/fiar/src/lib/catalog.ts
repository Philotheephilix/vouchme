import type { Item } from "./policy";

/**
 * Fiar's catalogue. Owners are real ids in the VouchMe graph Fiar is pointed at, so the
 * borrower-to-owner hop count on every card is a live read rather than a decoration — change
 * `VOUCHME_API_URL` to a deployment with different members and these owners stop resolving,
 * which is the correct and visible failure.
 */
export const CATALOG: Item[] = [
  {
    id: "drill",
    name: "Hammer drill, corded",
    valueUsd: 180,
    listRatePerDayUsd: 10,
    owner: "bob.vouchme.eth",
    neighbourhood: "Graça",
    note: "Two masonry bits in the case. Bring your own extension lead.",
  },
  {
    id: "tent",
    name: "Four-person tent",
    valueUsd: 320,
    listRatePerDayUsd: 14,
    owner: "alice.vouchme.eth",
    neighbourhood: "Alvalade",
    note: "Dry when it left. Please put it away dry.",
  },
  {
    id: "table",
    name: "Folding table and six chairs",
    valueUsd: 140,
    listRatePerDayUsd: 6,
    owner: "iris.vouchme.eth",
    neighbourhood: "Arroios",
    note: "Fits in a hatchback with the seats down. Just.",
  },
  {
    id: "washer",
    name: "Pressure washer",
    valueUsd: 240,
    listRatePerDayUsd: 12,
    owner: "grace.bob.vouchme.eth",
    neighbourhood: "Benfica",
    note: "Patio nozzle included. The lance leaks a little at the collar.",
  },
  {
    id: "trailer",
    name: "Cargo bike trailer",
    valueUsd: 260,
    listRatePerDayUsd: 11,
    owner: "dave.carol.vouchme.eth",
    neighbourhood: "Marvila",
    note: "Takes 40kg. The hitch fits most rear axles.",
  },
  {
    id: "camera",
    name: "Camera body and 24-70mm",
    valueUsd: 520,
    listRatePerDayUsd: 28,
    owner: "henry.vouchme.eth",
    neighbourhood: "Príncipe Real",
    note: "Two batteries, one charger, one card. Lens hood is missing.",
  },
];

export function findItem(id: string): Item | undefined {
  return CATALOG.find((item) => item.id === id);
}
