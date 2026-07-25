// HeroUI's Tailwind v4 plugin registration, loaded from globals.css via `@plugin './hero.ts'`.
// Kept file-local and un-configured on purpose: every visual decision in this app is driven by the
// design tokens in globals.css `@theme` and applied directly with Tailwind utilities, not by
// HeroUI's own theme palette, so there is nothing to override here.
import { heroui } from "@heroui/react";

export default heroui();
