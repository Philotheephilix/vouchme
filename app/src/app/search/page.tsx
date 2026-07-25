import { Header } from "@/components/Header";
import { SearchBox } from "@/components/SearchBox";

export default function SearchPage() {
  return (
    <div className="pb-8">
      <Header eyebrow="SEARCH" />
      <section className="px-4 pt-6">
        {/* The examples used to be `alice` / `alice.aval.eth`. Nobody by that name has ever
            enrolled on this deployment, so both were invented members offered as things to look
            up. Show the shape of a handle without naming an account that doesn't exist. */}
        <p className="mb-4 text-2xs leading-relaxed text-graphite">
          Find an enrolled member by handle — the bare label or the full{" "}
          <span className="font-mono">&lt;handle&gt;.aval.eth</span> — or by wallet address.
        </p>
        <SearchBox />
      </section>
    </div>
  );
}
