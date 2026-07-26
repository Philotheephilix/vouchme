import { cookies } from "next/headers";
import Link from "next/link";
import { ClaimButton } from "@/components/ClaimButton";
import { PreviewBar } from "@/components/PreviewBar";
import { SignIn, SignOut } from "@/components/SignIn";
import { claimsFor } from "@/lib/claims";
import { POOLS, qualifies, requirementLabel } from "@/lib/pools";
import { readVerifiedAddress } from "@/lib/session";
import { readStanding } from "@/lib/vouchme";

// Standing is revocable in one tap and takes effect on the next read, so a cached page is a page
// offering a pool that is no longer earned.
export const dynamic = "force-dynamic";

const PREVIEW_NAMES = ["carol.alice.vouchme.eth", "alice.vouchme.eth", "anchor1.vouchme.eth", "ring1.eth"];

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default async function LendPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const address = readVerifiedAddress(await cookies());

  // A verified session outranks the preview, always. The preview only ever chooses whose public
  // score is drawn; `/api/claim` never sees it.
  const asParam = (await searchParams).as;
  const preview = address ? null : typeof asParam === "string" && asParam ? asParam : null;

  const subject = address ?? preview;
  const { standing, unavailable } = await readStanding(subject);
  const claimed = claimsFor(address);

  const tierLabel = standing?.kind === "anchor" ? "Anchor" : `Tier ${standing?.tier ?? 0}`;

  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">Lend</h1>
        <span className="unit">WLD</span>
      </header>

      {address ? null : <PreviewBar current={preview} names={PREVIEW_NAMES} />}

      <section className="score-card" aria-label="Your standing">
        <span className="label">Score</span>
        <div className="score-row">
          <strong className={`score-figure${standing ? "" : " is-empty"}`}>{standing ? standing.score : "—"}</strong>
          <span className={`tier-pill${standing?.kind === "anchor" ? " is-anchor" : ""}`}>{tierLabel}</span>
        </div>
        <p className="identity">
          {unavailable ?? standing?.ensName ?? (subject ? short(subject) : "Not signed in")}
        </p>
      </section>

      {address ? null : <SignIn />}

      <ul className="pools" aria-label="Pools">
        {POOLS.map((pool) => {
          const open = qualifies(pool, standing);
          const record = claimed.get(pool.id);
          return (
            <li key={pool.id} className={`pool${open ? "" : " is-locked"}`}>
              <div>
                <div className="pool-name">{pool.name}</div>
                <div className="pool-amount">{pool.amountWld} WLD</div>
              </div>
              {record ? (
                record.txHash ? (
                  <a
                    className="sent"
                    href={`https://worldscan.org/tx/${record.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Sent
                  </a>
                ) : (
                  <span className="chip">Sending</span>
                )
              ) : !open ? (
                <span className="chip">{requirementLabel(pool.requirement)}</span>
              ) : address ? (
                <ClaimButton pool={pool.id} />
              ) : (
                <span className="chip">Sign in</span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Deliberately below the pools and deliberately quiet. Reporting spends Lend's own bond and
          costs someone else their standing; it is not a call to action. */}
      <nav className="nav" style={{ marginTop: "1.5rem" }}>
        <Link className="btn btn-quiet" href="/report">
          Report someone →
        </Link>
      </nav>

      <footer className="foot">
        <span>
          {standing ? `${standing.meta.mode} · block ${standing.meta.computedAtBlock}` : "VouchMe"}
        </span>
        {address ? <SignOut /> : null}
      </footer>
    </main>
  );
}
