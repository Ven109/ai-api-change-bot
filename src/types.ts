// Shared data shapes. These are the contracts between pipeline stages; every
// stage reads and writes plain JSON under .acb/ so stages stay independently
// runnable and inspectable.

/** Where in the repo an external API is used. */
export type CallSite = {
  file: string;
  line: number;
  snippet: string;
  /** HTTP integrations: verb, uppercase. */
  method?: string;
  /** HTTP integrations: path with interpolations normalized to {x}. */
  pathTemplate?: string;
  /** HTTP integrations: query parameter names we could see statically. */
  queryParams?: string[];
  /** SDK integrations: member chain such as `client.charges.create`. */
  member?: string;
};

export type IntegrationKind = "http" | "sdk";

export type Integration = {
  /** `http:<host>`, `npm:<pkg>` or `pypi:<pkg>`. */
  id: string;
  kind: IntegrationKind;
  /** HTTP integrations. */
  host?: string;
  /** SDK integrations. */
  package?: string;
  /** SDK integrations: the range declared in the repo manifest. */
  declaredVersion?: string;
  callSites: CallSite[];
};

export type Manifest = {
  version: 1;
  generatedAt: string;
  /** path -> sha256, so later scans only reparse what changed. */
  files: Record<string, string>;
  integrations: Integration[];
  /** OpenAPI/Swagger documents checked into the repo. */
  specs: string[];
  /**
   * Fingerprint of the repo-wide base-URL constants. When it changes, files
   * that did not change can still mean something different, so the next scan
   * reparses everything.
   */
  sharedConstantsHash?: string;
};

/** A single upstream change worth considering, from a spec diff or prose source. */
export type ChangeEntry = {
  id: string;
  integrationId: string;
  source: string;
  /** "openapi" entries carry structured identifiers; "changelog" entries are prose. */
  kind: "openapi" | "changelog";
  title: string;
  body: string;
  date?: string;
  version?: string;
  tags: string[];
  identifiers: ChangeIdentifier[];
};

export type ChangeIdentifier = {
  method?: string;
  pathTemplate?: string;
  param?: string;
  field?: string;
  token?: string;
};

/** The concrete thing in the code that matched, so validation can check it went away. */
export type MatchEvidence = {
  /** The path template the call site used (the old one, pre-migration). */
  pathTemplate?: string;
  /** A query parameter the call site passed. */
  param?: string;
  /** An SDK member chain. */
  member?: string;
  /** A response field read in the code. */
  field?: string;
};

export type CandidateMatch = {
  file: string;
  line: number;
  reason: string;
  evidence?: MatchEvidence;
};

export type Candidate = {
  entryId: string;
  integrationId: string;
  score: number;
  matches: CandidateMatch[];
};

export type Risk = "low" | "medium" | "high";

export type ImpactItem = {
  id: string;
  entryId: string;
  integrationId: string;
  relevant: boolean;
  confidence?: number;
  risk: Risk;
  deadline?: string;
  summary: string;
  whatChanged?: string;
  affected: { file: string; line: number; reason: string }[];
  migrationSteps: string[];
  dependencyChanges: string[];
  validationHints: string[];
  /** How this item was produced, so reports can show the deterministic/LLM split. */
  analyzedBy: "deterministic" | string;
  dismissedReason?: string;
};

export type ValidationCheck = {
  name: string;
  passed: boolean;
  details: string;
};

export type ValidationResult = {
  passed: boolean;
  checks: ValidationCheck[];
};

export type MigrationStatus =
  | "report-only"
  | "validated"
  | "failed-validation"
  | "incomplete";
