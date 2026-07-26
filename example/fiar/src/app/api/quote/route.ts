import { findItem } from "@/lib/catalog";
import { ladder, quote, youRung } from "@/lib/policy";
import { readProximity, readStanding } from "@/lib/vouchme";

/**
 * `GET /api/quote?item=drill&borrower=carol.alice.vouchme.eth`
 *
 * The same quote the cards render, as JSON. Here so the integration can be checked with curl
 * rather than read off a screenshot, and so the demo can show that the price really did move
 * because the standing did.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const itemId = url.searchParams.get("item");
  const borrower = url.searchParams.get("borrower");

  if (!itemId) {
    return Response.json({ error: "Pass ?item=<id>. Try 'drill'." }, { status: 400 });
  }
  const item = findItem(itemId);
  if (!item) {
    return Response.json({ error: `No item "${itemId}" in the catalogue.` }, { status: 404 });
  }

  const [{ standing, unavailable }, hops] = await Promise.all([
    readStanding(borrower),
    readProximity(borrower, [item]),
  ]);
  if (unavailable) {
    // Fiar cannot price without a reading, and quoting the full price silently would look
    // identical to quoting an unvouched borrower. Say which it is.
    return Response.json({ error: unavailable }, { status: 503 });
  }

  const closeness = hops.get(item.id) ?? null;
  return Response.json({
    item: { id: item.id, name: item.name, valueUsd: item.valueUsd, owner: item.owner },
    borrower: standing
      ? { ensName: standing.ensName, score: standing.score, tier: standing.tier, kind: standing.kind }
      : null,
    closeness,
    quote: quote({ item, standing, hopsToOwner: closeness?.hops ?? null }),
    ladder: ladder(item),
    you: youRung(item, standing),
    // Provenance travels with the price, exactly as it does on screen.
    vouchme: standing?.meta ?? null,
  });
}
