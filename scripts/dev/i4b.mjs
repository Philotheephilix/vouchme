import { compute, BASE, T1, T2 } from "../../engine/dist/index.js";
const now = 1_800_000_000;
function run(nAnchors) {
  const anchors = Array.from({length: nAnchors}, (_,i)=>`a${i}`);
  const accounts = [
    ...anchors.map(id=>({id, kind:"human", isAnchor:true, active:true})),
    {id:"U", kind:"human", active:true},
    {id:"V1", kind:"human", active:true},
    {id:"V2", kind:"human", active:true},
    {id:"W", kind:"human", active:true},
  ];
  const v=(voucher,vouchee)=>({voucher,vouchee,active:true});
  const vouches=[
    ...anchors.map(a=>v(a,"U")),
    v("U","V1"), v("U","V2"),
    v("V1","W"), v("V2","W"), v("U","W"),
  ];
  const out = compute({now, accounts, vouches, platformVouches:[], reports:[]});
  return {U:out.score.U, V1:out.score.V1, W:out.score.W, depthW:out.depth?.W, tierW:out.tier?.W};
}
for (const n of [4,5,6,7]) {
  const r = run(n);
  console.log(`anchors=${n}  U=${r.U}  V1=${r.V1}  W=${r.W} (depth ${r.depthW}, tier ${r.tierW})`);
}
console.log("T1 =", T1, " T2 =", T2, " BASE =", BASE);
