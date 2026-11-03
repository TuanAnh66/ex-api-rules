export type RuleKind = 'documented' | 'observed' | 'inference';
export type Profile = 'default' | 'payments' | 'trading';
export interface Rule { id:string; kind:RuleKind; scope:'common'|'payments'|'trading'; statement:string; evidence:Record<string,unknown>[]; lifecycle?:{status:'draft'|'in_review'|'approved'|'deprecated'|'superseded';revision:number;introducedIn:string;supersededBy?:string}; [key:string]:unknown }
export interface PortableBundle { schemaVersion:2; manifest:{schemaVersion:1;id:string;bundleHash:string;sources:Record<string,unknown>[];[key:string]:unknown}; rules:Rule[]; blobs:Record<string,string> }
export const VERSION:string;
export function hash(value:string|Uint8Array):string;
export function stringify(value:unknown):string;
export function validate(name:'rule'|'bundle'|'report'|'lock'|'catalog'|'checks',value:unknown):unknown;
export function pointer(document:unknown,reference:string):unknown;
export function verifyPortable(bundle:PortableBundle):{manifest:PortableBundle['manifest'];rules:Rule[];artifactSha256:string;blobDigests:string[]};
export function selectRules(rules:Rule[],profile?:Profile):Rule[];
export function openApiValidator(document:unknown,schemaName:string):(value:unknown)=>boolean;
export function toSarif(report:Record<string,unknown>):Record<string,unknown>;

export function canonical(value:unknown):unknown;
export function referencedDigests(manifest:PortableBundle['manifest'],rules:Rule[]):string[];
export function decodeBlob(encoded:string):Uint8Array;
