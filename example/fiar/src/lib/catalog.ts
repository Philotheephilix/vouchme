import type { Item } from "./policy";

/**
 * Fiar's catalogue. Owners are real ids in the VouchMe graph Fiar is pointed at, so the
 * borrower-to-owner hop count on every card is a live read rather than a decoration — change
 * `VOUCHME_API_URL` to a deployment with different members and these owners stop resolving,
 * which is the correct and visible failure.
 */
export const CATALOG: Item[] = [
  {
    id: "table",
    name: "Folding table and six chairs",
    valueUsd: 30,
    listRatePerDayUsd: 1.5,
    owner: "iris.vouchme.eth",
    neighbourhood: "Arroios",
    note: "Fits in a hatchback with the seats down. Just.",
  },
  {
    id: "drill",
    name: "Hammer drill, corded",
    valueUsd: 45,
    listRatePerDayUsd: 2,
    owner: "bob.vouchme.eth",
    neighbourhood: "Graça",
    note: "Two masonry bits in the case. Bring your own extension lead.",
  },
  {
    id: "trailer",
    name: "Cargo bike trailer",
    valueUsd: 55,
    listRatePerDayUsd: 2.2,
    owner: "dave.carol.vouchme.eth",
    neighbourhood: "Marvila",
    note: "Takes 40kg. The hitch fits most rear axles.",
  },
  {
    id: "washer",
    name: "Pressure washer",
    valueUsd: 60,
    listRatePerDayUsd: 2.5,
    owner: "grace.bob.vouchme.eth",
    neighbourhood: "Benfica",
    note: "Patio nozzle included. The lance leaks a little at the collar.",
  },
  {
    id: "tent",
    name: "Four-person tent",
    valueUsd: 75,
    listRatePerDayUsd: 3,
    owner: "alice.vouchme.eth",
    neighbourhood: "Alvalade",
    note: "Dry when it left. Please put it away dry.",
  },
  {
    id: "camera",
    name: "Camera body and 24-70mm",
    valueUsd: 120,
    listRatePerDayUsd: 5,
    owner: "henry.vouchme.eth",
    neighbourhood: "Príncipe Real",
    note: "Two batteries, one charger, one card. Lens hood is missing.",
  },
];

export function findItem(id: string): Item | undefined {
  return CATALOG.find((item) => item.id === id);
}
