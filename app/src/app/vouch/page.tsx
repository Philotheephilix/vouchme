import { Suspense } from "react";
import { VouchWizard } from "./VouchWizard";

// The wizard is fully client-driven: it fetches its own candidate list and simulation for whichever
// wallet is actually signed in, so there is nothing left for a server component to precompute.
// It reads `?to=` via useSearchParams, which Next requires be under a Suspense boundary so the
// static shell can prerender without bailing the whole route to client-side rendering.
export default function VouchPage() {
  return (
    <Suspense fallback={null}>
      <VouchWizard />
    </Suspense>
  );
}
