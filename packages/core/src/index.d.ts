export type RuleKind = 'documented' | 'observed' | 'inference';
export type Profile = 'default' | 'payments' | 'trading';
export type Canonicalization = 'utf16-v1' | 'ecmascript-v0';
export interface Rule { id:string; kind:RuleKind; scope:'common'|'payments'|'trading'; statement:string; evidence:Record<string,unknown>[]; lifecycle?:{status:'draft'|'in_review'|'approved'|'deprecated'|'superseded';revision:number;introducedIn:string;supersededBy?:string}; [key:string]:unknown }
export interface PortableBundle { schemaVersion:2; manifest:{schemaVersion:1;canonicalization?:Canonicalization;id:string;bundleHash:string;sources:Record<string,unknown>[];[key:string]:unknown}; rules:Rule[]; blobs:Record<string,string> }
export const VERSION:string;
export function hash(value:string|Uint8Array):string;
export function stringify(value:unknown):string;
export function legacyStringify(value:unknown):string;
export function bundleStringify(manifest:PortableBundle['manifest'],value:unknown):string;
export function validate(name:'report',value:unknown):ReportV1|ReportV2;
export function validate(name:'rule'|'bundle'|'report'|'lock'|'catalog'|'checks',value:unknown):unknown;
export function reportFingerprint(report:ReportV2):string;
export function pointer(document:unknown,reference:string):unknown;
export function verifyPortable(bundle:PortableBundle):{manifest:PortableBundle['manifest'];rules:Rule[];artifactSha256:string;blobDigests:string[]};
export function selectRules(rules:Rule[],profile?:Profile):Rule[];
export function openApiValidator(document:unknown,schemaName:string):(value:unknown)=>boolean;
export function toSarif(report:Record<string,unknown>):Record<string,unknown>;

export function canonical(value:unknown):unknown;
export function referencedDigests(manifest:PortableBundle['manifest'],rules:Rule[]):string[];
export function decodeBlob(encoded:string):Uint8Array;

export type FileAnalysisStatus = 'analyzed'|'unsupported'|'parse-failed'|'analysis-failed'|'budget-exceeded'|'read-failed'|'changed-during-read'|'missing'|'not-regular'|'excluded';
export interface ReviewFile { file:string; sha256:string|null; hashStatus:'complete'|'not-computed'; adapter:'javascript'|'unsupported'; analysisStatus:FileAnalysisStatus; adapterStatus:'completed'|'parse-failed'|'failed'|'not-run'; reason:string|null; sizeBytes:number|null; bytesRead:number; budgetBytesCharged:number }
export interface ReportV1 extends Record<string,unknown> { schemaVersion:1 }
export type CheckExecutionStatus = 'ran'|'partial'|'manual-only'|'not-applicable'|'not-run';
export interface ReviewInputPolicy { maxFileBytes:number; maxTotalBytes:number; chunkBytes:65536; fileOrder:'utf16-path-order'; selection:'explicit'|'changed-and-untracked'; baseRef:string|null; untrackedIgnored:'exclude-in-base-only'; privatePaths:'reject-explicit-report-base' }
export type ReviewEvidence = {sourceId:string;url:string;terms:string[];snapshot:string;sha256:string;fetchedAt:string|null;pointer?:string;originalPath?:string}|{sourceId?:never;snapshot:string;sha256:string;originalPath?:string};
export interface ReviewFinding { file:string;line:number;column?:number;ruleId:string;severity:'P1'|'P2'|'P3';kind:'documented'|'observed';title:string;recommendation:string;evidence:ReviewEvidence[] }
export interface ManualCheck { file:string;line:number|null;ruleId:string|null;reason:string;category:'behavior-review'|'unanalyzed'|'excluded' }
export interface CheckRegistryEntry { id:string;ruleIds:string[];adapter:'javascript';tests:string[] }
export interface RuleInventory { id:string;kind:RuleKind;scope:Rule['scope'];status:'draft'|'in_review'|'approved'|'deprecated'|'superseded'|'legacy' }
export interface ReviewCoverage { measurement:'selected-rule-inventory-only';automatedFindingsOnly:true;unprovenComplianceIsNotPass:true;ruleCount:number;selectedRules:RuleInventory[];excludedRules:(RuleInventory&{reason:string})[];checks:CheckRegistryEntry[];checkApplicability:{file:string;checkId:string;ruleIds:string[];status:CheckExecutionStatus;reason:string|null}[];unsupportedFiles:string[];parseFailedFiles:string[];unanalyzedFiles:string[] }
export interface ReportV2 {
  [key:string]:unknown;
  schemaVersion:2;createdAt:string;toolVersion:string;ruleVersion:string;bundleId:string;bundleHash:string;artifactSha256:string;
  bundleCanonicalization:Canonicalization;fingerprintCanonicalization:'utf16-v1';profile:Profile;projectLock:'pinned'|'legacy-compatibility-unlocked';
  codeVersion:{head:string;headStatus:'available'|'unavailable';files:ReviewFile[]};inputPolicy:ReviewInputPolicy;
  sourceFreshness:{mode:'offline-pinned-snapshot';collectedAt:string|null;latestCheck:{checkedAt:string;status:'complete'|'incomplete';summary:Record<string,unknown>}|null;latestClaim:false};
  outcome:'PARTIAL_REVIEW_REQUIRES_HUMAN';findings:ReviewFinding[];manualChecks:ManualCheck[];coverage:ReviewCoverage;
  conflicts:{ruleId:string;conflictsWith:string[];evidence:ReviewEvidence[]}[];limitations:string[];resultFingerprint:string;
}
export function ruleChanges(before:Rule[],after:Rule[]):{id:string;classification:'added'|'removed'|'changed'|'unchanged';before:Rule|null;after:Rule|null}[];
export function ruleHistoryIssues(before:Rule[],after:Rule[]):{ruleId:string;reason:string}[];
