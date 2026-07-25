import { compute } from "../../engine/dist/index.js";
const A = (id) => ({ id, kind: "human", isAnchor: true, active: true });
const H = (id) => ({ id, kind: "human", active: true });
const V = (voucher, vouchee) => ({ voucher, vouchee, active: true });
const now = 1_800_000_000;
function run(n) {
  const anchors = Array.from({ length: n }, (_, i) => A(`A${i}`));
  const out = compute({
    now,
    accounts: [...anchors, A("B1"), A("B2"), H("U"), H("X"), H("Y"), H("W")],
    vouches: [
      ...anchors.map((a) => V(a.id, "U")),
      V("B1", "X"), V("B2", "X"),
      V("B1", "Y"), V("B2", "Y"),
      V("U", "W"), V("X", "W"), V("Y", "W"),
    ],
    platformVouches: [], reports: [],
  });
  return { U: out.score.U, dU: out.depth?.U, tU: out.tier?.U, W: out.score.W, dW: out.depth?.W, tW: out.tier?.W };
}
for (const n of [4,5,6,7]) {
  const r = run(n);
  console.log(`n=${n}  U=${r.U} d=${r.dU} t=${r.tU}    W=${r.W} d=${r.dW} t=${r.tW}`);
}
