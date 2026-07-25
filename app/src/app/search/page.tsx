import { Header } from "@/components/Header";
import { SearchBox } from "@/components/SearchBox";

export default function SearchPage() {
  return (
    <div className="pb-8">
      <Header eyebrow="SEARCH" />
      <section className="px-4 pt-6">
        <p className="mb-4 text-2xs leading-relaxed text-graphite">
          Find an enrolled member by handle (<span className="font-mono">alice</span> or{" "}
          <span className="font-mono">alice.aval.eth</span>) or wallet address.
        </p>
        <SearchBox />
      </section>
    </div>
  );
}
