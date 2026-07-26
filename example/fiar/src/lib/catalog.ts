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
    valueWld: 0.02,
    listRatePerDayWld: 0.001,
    owner: "iris.vouchme.eth",
    neighbourhood: "Arroios",
    note: "Fits in a hatchback with the seats down. Just.",
  },
  {
    id: "drill",
    name: "Hammer drill, corded",
    valueWld: 0.03,
    listRatePerDayWld: 0.0015,
    owner: "bob.vouchme.eth",
    neighbourhood: "Graça",
    note: "Two masonry bits in the case. Bring your own extension lead.",
  },
  {
    id: "trailer",
    name: "Cargo bike trailer",
    valueWld: 0.04,
    listRatePerDayWld: 0.002,
    owner: "dave.carol.vouchme.eth",
    neighbourhood: "Marvila",
    note: "Takes 40kg. The hitch fits most rear axles.",
  },
  {
    id: "washer",
    name: "Pressure washer",
    valueWld: 0.05,
    listRatePerDayWld: 0.0025,
    owner: "grace.bob.vouchme.eth",
    neighbourhood: "Benfica",
    note: "Patio nozzle included. The lance leaks a little at the collar.",
  },
  {
    id: "tent",
    name: "Four-person tent",
    valueWld: 0.07,
    listRatePerDayWld: 0.0035,
    owner: "alice.vouchme.eth",
    neighbourhood: "Alvalade",
    note: "Dry when it left. Please put it away dry.",
  },
  {
    id: "camera",
    name: "Camera body and 24-70mm",
    valueWld: 0.1,
    listRatePerDayWld: 0.005,
    owner: "henry.vouchme.eth",
    neighbourhood: "Príncipe Real",
    note: "Two batteries, one charger, one card. Lens hood is missing.",
  },
];

export function findItem(id: string): Item | undefined {
  return CATALOG.find((item) => item.id === id);
}
