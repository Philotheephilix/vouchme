import { VouchWizard } from "./VouchWizard";

// The wizard is fully client-driven: it fetches its own candidate list and simulation for whichever
// wallet is actually signed in, so there is nothing left for a server component to precompute.
export default function VouchPage() {
  return <VouchWizard />;
}
