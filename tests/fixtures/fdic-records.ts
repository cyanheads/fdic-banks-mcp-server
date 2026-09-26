/**
 * @fileoverview BankFind row fixtures: synthetic values in the recorded field
 * shapes of `/institutions`, `/financials`, `/failures`, and `/sod` — numeric
 * codes as numbers, RSSD IDs as strings, ZIP codes as strings, `MM/DD/YYYY` /
 * `YYYYMMDD` / `M/D/YYYY` dates, and the absence sentinels and sparse rows the
 * design depends on.
 * @module tests/fixtures/fdic-records
 */

// ---------------------------------------------------------------------------
// /institutions
// ---------------------------------------------------------------------------

/** Active state nonmember bank under a top-tier holding company. */
export const HARBOR_BANK = {
  NAMEHCR: 'EVERGREEN HARBOR BANCORP',
  REGAGNT: 'FDIC',
  ACTIVE: 1,
  BKCLASS: 'NM',
  REPDTE: '06/30/2026',
  FED_RSSD: '2345678',
  NEWCERT: 0,
  ASSET: 2456123,
  INSDATE: '04/02/1998',
  DEP: 2101456,
  NAME: 'Evergreen Harbor Bank',
  CITY: 'Tacoma',
  RSSDHCR: '3456789',
  OFFDOM: 14,
  ENDEFYMD: '12/31/9999',
  CERT: 57701,
  STALP: 'WA',
  ESTYMD: '04/02/1998',
  COUNTY: 'Pierce',
  ID: '57701',
};

/**
 * Active bank with no holding company: FDIC sends `NAMEHCR`/`RSSDHCR` as blank
 * strings, `NEWCERT: 0`, the `12/31/9999` end date, and here a blank county.
 */
export const SOLO_BANK = {
  NAMEHCR: '',
  REGAGNT: 'OCC',
  ACTIVE: 1,
  BKCLASS: 'SB',
  REPDTE: '06/30/2026',
  FED_RSSD: '1499001',
  NEWCERT: 0,
  ASSET: 61234,
  INSDATE: '11/01/1990',
  DEP: 52011,
  NAME: 'Cedar Flats Community Bank',
  CITY: 'Walla Walla',
  RSSDHCR: '',
  OFFDOM: 1,
  ENDEFYMD: '12/31/9999',
  CERT: 33990,
  STALP: 'WA',
  ESTYMD: '11/01/1990',
  COUNTY: '',
  ID: '33990',
};

/** Failed bank: inactive, ended on ENDEFYMD, franchise continued under NEWCERT. */
export const FAILED_BANK = {
  NAMEHCR: 'SUMMIT VALLEY FINANCIAL GROUP',
  REGAGNT: 'FED',
  ACTIVE: 0,
  BKCLASS: 'SM',
  REPDTE: '12/31/2022',
  FED_RSSD: '802111',
  NEWCERT: 58812,
  ASSET: 201234000,
  INSDATE: '10/17/1983',
  DEP: 170456000,
  NAME: 'Summit Valley Bank',
  CITY: 'Santa Clara',
  RSSDHCR: '1033001',
  OFFDOM: 17,
  ENDEFYMD: '03/10/2023',
  CERT: 24900,
  STALP: 'CA',
  ESTYMD: '10/17/1983',
  COUNTY: 'Santa Clara',
  ID: '24900',
};

/**
 * Short-lived bridge bank: FDIC omits empty valid fields from the row entirely —
 * no holding company, no assets, deposits, offices, or report date.
 */
export const BRIDGE_BANK = {
  REGAGNT: 'OCC',
  ACTIVE: 0,
  BKCLASS: 'N',
  FED_RSSD: '5836001',
  NEWCERT: 11200,
  INSDATE: '03/13/2023',
  NAME: 'Summit Valley Bridge Bank, National Association',
  CITY: 'Santa Clara',
  ENDEFYMD: '03/26/2023',
  CERT: 59400,
  STALP: 'CA',
  ESTYMD: '03/13/2023',
  COUNTY: 'Santa Clara',
  ID: '59400',
};

// ---------------------------------------------------------------------------
// /financials
// ---------------------------------------------------------------------------

/** FDIC fields of the default health set, in the catalog's default-set order. */
export const DEFAULT_METRIC_FIELDS = [
  'ASSET',
  'DEP',
  'DEPUNINS',
  'EQ',
  'NETINCQ',
  'ROAQ',
  'ROEQ',
  'NIMYQ',
  'EEFFQR',
  'NCLNLSR',
  'NTLNLSQR',
  'LNLSDEPR',
  'RBC1AAJ',
  'IDT1CER',
  'RBCRWAJ',
] as const;

const HEALTH_VALUES: Record<(typeof DEFAULT_METRIC_FIELDS)[number], number> = {
  ASSET: 2456123,
  DEP: 2101456,
  DEPUNINS: 812345,
  EQ: 245678,
  NETINCQ: 7123,
  ROAQ: 1.16,
  ROEQ: 11.62,
  NIMYQ: 3.42,
  EEFFQR: 61.8,
  NCLNLSR: 0.4212,
  NTLNLSQR: 0.11,
  LNLSDEPR: 88.31,
  RBC1AAJ: 10.123456,
  IDT1CER: 13.4,
  RBCRWAJ: 14.93,
};

/** One `/financials` row: `REPDTE` as `YYYYMMDD`, `ID` as `<cert>_<repdte>`. */
export function financialRow(
  cert: number,
  repdte: string,
  values: Record<string, unknown> = HEALTH_VALUES,
): Record<string, unknown> {
  return { ...values, REPDTE: repdte, ID: `${cert}_${repdte}` };
}

/** A default-set row with some fields overridden. */
export function healthRow(
  cert: number,
  repdte: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return financialRow(cert, repdte, { ...HEALTH_VALUES, ...overrides });
}

// ---------------------------------------------------------------------------
// /failures
// ---------------------------------------------------------------------------

/** Modern DIF failure resolved by purchase and assumption, with an acquirer and a loss estimate. */
export const PA_FAILURE = {
  RESDATE: '3/14/2025',
  QBFDEP: 398765,
  BIDCITY: 'ROCHESTER',
  BIDSTATE: 'MN',
  BIDNAME: 'NORTHSTAR COMMUNITY BANK',
  PSTALP: 'MN',
  FIN: '10601',
  FAILDATE: '3/14/2025',
  RESTYPE: 'FAILURE',
  COSTMOSTRECENTASOF: '2026-06-30',
  SAVR: 'DIF',
  RESTYPE1: 'PA',
  NAME: 'PINE RIVER STATE BANK',
  CHCLASS1: 'NM',
  COST: 51234.567,
  QBFASSET: 412345,
  CITY: 'WINONA',
  CERT: 58321,
  ID: '4190',
};

/**
 * Pre-1977 payout: no CERT (null), `FIN "0"`, `"0"` in all three acquirer fields,
 * null `RESDATE`, null `COST`, null `QBFASSET`, and a blank estimate date.
 */
export const SPARSE_FAILURE = {
  RESDATE: null,
  QBFDEP: 41,
  BIDCITY: '0',
  BIDSTATE: '0',
  BIDNAME: '0',
  PSTALP: 'ND',
  FIN: '0',
  FAILDATE: '8/14/1937',
  RESTYPE: 'FAILURE',
  COSTMOSTRECENTASOF: '',
  SAVR: 'FDIC',
  RESTYPE1: 'PO',
  NAME: 'THE PRAIRIE STATE BANK',
  CHCLASS1: 'NM',
  COST: null,
  QBFASSET: null,
  CITY: 'LISBON',
  CERT: null,
  ID: '212',
};

/** 2009 open-bank assistance: no acquirer, no loss estimate. */
export const ASSISTANCE_EVENT = {
  RESDATE: '1/16/2009',
  QBFDEP: 60123456,
  BIDCITY: '0',
  BIDSTATE: '0',
  BIDNAME: '0',
  PSTALP: 'CO',
  FIN: '0',
  FAILDATE: '1/16/2009',
  RESTYPE: 'ASSISTANCE',
  COSTMOSTRECENTASOF: '2026-06-30',
  SAVR: 'DIF',
  RESTYPE1: 'OBAM',
  NAME: 'GRANITE NATIONAL BANK',
  CHCLASS1: 'N',
  COST: null,
  QBFASSET: 81234567,
  CITY: 'DENVER',
  CERT: 44120,
  ID: '3601',
};

/** A failure whose FDIC loss estimate is a real zero. */
export const ZERO_COST_FAILURE = {
  RESDATE: '10/23/2020',
  QBFDEP: 139876,
  BIDCITY: 'CHARLESTON',
  BIDSTATE: 'WV',
  BIDNAME: 'KANAWHA VALLEY BANK',
  PSTALP: 'WV',
  FIN: '10537',
  FAILDATE: '10/23/2020',
  RESTYPE: 'FAILURE',
  COSTMOSTRECENTASOF: '2026-06-30',
  SAVR: 'DIF',
  RESTYPE1: 'PI',
  NAME: 'ALLEGHENY FARMERS BANK',
  CHCLASS1: 'SM',
  COST: 0,
  QBFASSET: 151234,
  CITY: 'ELKINS',
  CERT: 7811,
  ID: '4102',
};

// ---------------------------------------------------------------------------
// /financials panel rows
// ---------------------------------------------------------------------------

/**
 * One panel row: a default-set `/financials` row plus the `CERT`, `NAME` (as
 * filed on the Call Report, uppercase and abbreviated), and `STALP` fields the
 * panel requests.
 */
export function panelRow(
  cert: number,
  repdte: string,
  identity: { NAME: string; STALP: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { CERT: cert, ...identity, ...healthRow(cert, repdte, overrides) };
}

// ---------------------------------------------------------------------------
// /sod (Summary of Deposits branch rows)
// ---------------------------------------------------------------------------

/** Main office (`BRNUM 0`, `BKMO 1`) of a metropolitan institution, with SIMS coordinates. */
export const MAIN_OFFICE_BRANCH = {
  YEAR: 2026,
  CERT: 57701,
  NAMEFULL: 'Evergreen Harbor Bank',
  BRNUM: 0,
  UNINUMBR: 204118,
  NAMEBR: 'Evergreen Harbor Bank Main Office',
  BKMO: 1,
  ADDRESBR: '1101 Pacific Avenue',
  CITYBR: 'Tacoma',
  CNTYNAMB: 'Pierce',
  STALPBR: 'WA',
  ZIPBR: '98402',
  MSABR: 42660,
  MSANAMB: 'Seattle-Tacoma-Bellevue, WA',
  DEPSUMBR: 1302456,
  SIMS_ESTABLISHED_DATE: '04/02/1998',
  SIMS_LATITUDE: 47.2529,
  SIMS_LONGITUDE: -122.4443,
  ID: '2026_57701_204118',
};

/**
 * Non-metropolitan branch: `MSABR 0` (FDIC's value outside any CBSA), a blank MSA
 * name, and no SIMS establishment date or coordinates.
 */
export const RURAL_BRANCH = {
  YEAR: 2026,
  CERT: 57701,
  NAMEFULL: 'Evergreen Harbor Bank',
  BRNUM: 14,
  UNINUMBR: 377120,
  NAMEBR: 'Walla Walla Branch',
  BKMO: 0,
  ADDRESBR: '12 East Main Street',
  CITYBR: 'Walla Walla',
  CNTYNAMB: 'Walla Walla',
  STALPBR: 'WA',
  ZIPBR: '99362',
  MSABR: 0,
  MSANAMB: '',
  DEPSUMBR: 48210,
  ID: '2026_57701_377120',
};

/** Branch in a second state whose ZIP keeps its leading zero (`ZIPBR` is a string). */
export const BOSTON_BRANCH = {
  YEAR: 2026,
  CERT: 57701,
  NAMEFULL: 'Evergreen Harbor Bank',
  BRNUM: 3,
  UNINUMBR: 488001,
  NAMEBR: 'Financial District',
  BKMO: 0,
  ADDRESBR: '100 Federal Street',
  CITYBR: 'Boston',
  CNTYNAMB: 'Suffolk',
  STALPBR: 'MA',
  ZIPBR: '02110',
  MSABR: 14460,
  MSANAMB: 'Boston-Cambridge-Newton, MA-NH',
  DEPSUMBR: 250000,
  SIMS_ESTABLISHED_DATE: '11/15/2019',
  SIMS_LATITUDE: 42.3546,
  SIMS_LONGITUDE: -71.0561,
  ID: '2026_57701_488001',
};

/** A generated branch of the main office's institution, numbered `brnum`. */
export function sodBranch(
  brnum: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...MAIN_OFFICE_BRANCH,
    BRNUM: brnum,
    UNINUMBR: 600000 + brnum,
    NAMEBR: `Branch ${brnum}`,
    BKMO: 0,
    DEPSUMBR: 1000 + brnum,
    ID: `2026_57701_${600000 + brnum}`,
    ...overrides,
  };
}
