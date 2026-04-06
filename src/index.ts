// File: src/index.ts
/**
 * Public package entrypoint for the framework.
 *
 * This barrel exports the stable consumable surface for framework users and
 * keeps path imports from leaking internal directory structure into calling
 * applications.
 */

export * from "./types";
export * from "./orchestrator-support";
export * from "./orchestrator";
export * from "./memory";
export * from "./memory-backends";
export * from "./skills";
export * from "./teams";
export * from "./workflow-state";
export * from "./workflow-backend";
export * from "./workflow-backends";
export * from "./workflow-backend-adapter";
export * from "./backend-registry";
export * from "./workflow-engine";
export * from "./workflow-adapters";
export * from "./vendor-adapters";
export * from "./llm-gateway";
export * from "./provider-adapters";
export * from "./sdk-clients";
export * from "./runtime-platforms";
export * from "./bootstrap";
export * from "./example-bootstrap";
export * from "./notifiers";

// TODO:
// - Add explicit export curation if the package surface becomes too broad for semver stability.
// - Add subpath exports in `package.json` if consumers need narrower import boundaries.
