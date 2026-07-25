fn main() {
    // Hand-decoded, params-driven event matching (see src/lib.rs) — no Abigen,
    // no per-contract ABI. That is what makes the module composable across any
    // contract that follows the trust-graph v0.1.0 event shape (docs/14 §2):
    // only `trust_graph.proto` needs codegen.
    prost_build::compile_protos(&["proto/trust_graph.proto"], &["proto/"]).unwrap();
}
