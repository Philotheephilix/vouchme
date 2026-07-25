import { compute } from "../../engine/dist/index.js";
const A=(id)=>({id,kind:"human",isAnchor:true,active:true});
const H=(id)=>({id,kind:"human",active:true});
const now=1_800_000_000;
const base={now,accounts:[A("A1"),A("A2"),H("R"),H("U")],
  vouches:[{voucher:"A1",vouchee:"R",active:true},{voucher:"A2",vouchee:"R",active:true}],
  platformVouches:[]};
try {
  compute({...base, reports:[{id:"r1",reporter:"R",target:"U",state:"upheld",snapshotWeight:3000}]});
  console.log("REJECTED? no — upheld report with no upheldAt was ACCEPTED (bug still open)");
} catch (e) {
  console.log("rejected as expected:", String(e.message).split("\n")[0].slice(0,110));
}
const ok = compute({...base, reports:[{id:"r1",reporter:"R",target:"U",state:"upheld",upheldAt:now-86400,snapshotWeight:3000}]});
console.log("well-formed upheld report still works: U score =", ok.score.U);
try {
  compute({...base, reports:[{id:"r2",reporter:"R",target:"U",state:"upheld",upheldAt:now-86400}]});
  console.log("missing snapshotWeight ACCEPTED (bug still open)");
} catch (e) {
  console.log("missing snapshotWeight rejected:", String(e.message).slice(0,90));
}
