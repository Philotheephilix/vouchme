import { cookies } from "next/headers";
import Link from "next/link";
import { ClaimButton } from "@/components/ClaimButton";
import { IdentityCheck } from "@/components/IdentityCheck";
import { PreviewBar } from "@/components/PreviewBar";
import { SignIn, SignOut } from "@/components/SignIn";
import { claimsFor } from "@/lib/claims";
import { attestationSatisfies, identityLabel } from "@/lib/identity";
import { getAttestation } from "@/lib/identityStore";
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

  // The server's own conclusion, never a client's. Read here only to draw the right chip; the
  // decision that matters is re-made inside `/api/claim`.
  const attestation = getAttestation(address);

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
          // The two gates, evaluated and rendered separately all the way to the screen. A single
          // "locked" boolean would tell a person they cannot borrow without telling them which of
          // two entirely different things to go and fix.
          const standingOk = qualifies(pool, standing);
          const identityOk = attestationSatisfies(pool.identity, attestation);
          const open = standingOk && identityOk;
          const record = claimed.get(pool.id);
          return (
            <li key={pool.id} className={`pool${open ? "" : " is-locked"}`}>
              <div className="pool-row">
                <div>
                  <div className="pool-name">{pool.name}</div>
                  <div className="pool-amount">{pool.amountWld} WLD</div>
                  {/* Stated up front, before anyone taps anything. Someone who cannot pass the age
                      or jurisdiction requirement should learn it from the list, not after starting
                      a document check. */}
                  <div className="pool-meta">
                    {requirementLabel(pool.requirement)} · ID {identityLabel(pool.identity)}
                  </div>
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
                ) : !address ? (
                  <span className="chip">Sign in</span>
                ) : !standingOk ? (
                  // Standing is shown first deliberately. Sending someone through a document check
                  // they will pass, only to leave them locked on tier, is a wasted disclosure.
                  <span className="chip">{requirementLabel(pool.requirement)}</span>
                ) : !identityOk ? (
                  <span className="chip">ID check</span>
                ) : (
                  <ClaimButton pool={pool.id} />
                )}
              </div>
              {!record && address && standingOk && !identityOk ? (
                <IdentityCheck pool={pool.id} needsJurisdiction={pool.identity.jurisdiction === "served"} />
              ) : null}
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
