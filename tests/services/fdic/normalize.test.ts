/**
 * @fileoverview Tests for the BankFind row normalizers over recorded-shape rows:
 * numeric coercion, ISO dates, blanks and absence sentinels dropped to absent,
 * and zero-means-unreported ratios nulled.
 * @module tests/services/fdic/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  metricValues,
  normalizeFailure,
  normalizeInstitution,
  num,
  str,
} from '@/services/fdic/normalize.js';
import {
  ASSISTANCE_EVENT,
  BRIDGE_BANK,
  FAILED_BANK,
  HARBOR_BANK,
  PA_FAILURE,
  SOLO_BANK,
  SPARSE_FAILURE,
  ZERO_COST_FAILURE,
} from '../../fixtures/fdic-records.js';

describe('scalar coercion', () => {
  it('reads finite numbers from numbers and numeric strings only', () => {
    expect(num(3)).toBe(3);
    expect(num('1031449')).toBe(1031449);
    expect(num(' 2.5 ')).toBe(2.5);
    expect(num('')).toBeNull();
    expect(num('n/a')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(Number.NaN)).toBeNull();
  });

  it('trims strings, stringifies numbers, and drops blanks', () => {
    expect(str('  x ')).toBe('x');
    expect(str(7)).toBe('7');
    expect(str('   ')).toBeUndefined();
    expect(str(null)).toBeUndefined();
  });
});

describe('normalizeInstitution', () => {
  it('normalizes an active institution with a holding company', () => {
    expect(normalizeInstitution({ data: HARBOR_BANK })).toEqual({
      cert: 57701,
      name: 'Evergreen Harbor Bank',
      active: true,
      city: 'Tacoma',
      state: 'WA',
      county: 'Pierce',
      bank_class: { code: 'NM', label: 'State-chartered bank, not a Federal Reserve member' },
      regulator: 'FDIC',
      established_on: '1998-04-02',
      insured_since: '1998-04-02',
      holding_company: { name: 'EVERGREEN HARBOR BANCORP', rssd: 3456789 },
      fed_rssd: 2345678,
      total_assets: 2456123,
      total_deposits: 2101456,
      domestic_offices: 14,
      last_report_date: '2026-06-30',
    });
  });

  it('drops blank holding-company fields, a blank county, NEWCERT 0, and the 12/31/9999 end date', () => {
    const record = normalizeInstitution({ data: SOLO_BANK });
    expect(record).not.toHaveProperty('holding_company');
    expect(record).not.toHaveProperty('county');
    expect(record).not.toHaveProperty('successor_cert');
    expect(record).not.toHaveProperty('ended_on');
    expect(record.active).toBe(true);
  });

  it('keeps the end date and successor of an inactive institution', () => {
    expect(normalizeInstitution({ data: FAILED_BANK })).toMatchObject({
      active: false,
      ended_on: '2023-03-10',
      successor_cert: 58812,
      last_report_date: '2022-12-31',
    });
  });

  it('leaves fields FDIC omitted absent instead of zero-filling them', () => {
    const record = normalizeInstitution({ data: BRIDGE_BANK });
    for (const key of [
      'holding_company',
      'total_assets',
      'total_deposits',
      'domestic_offices',
      'last_report_date',
    ]) {
      expect(record).not.toHaveProperty(key);
    }
    expect(record.successor_cert).toBe(11200);
  });

  it('keeps holding_company without rssd when FDIC has a name but no RSSD', () => {
    const record = normalizeInstitution({ data: { ...HARBOR_BANK, RSSDHCR: '' } });
    expect(record.holding_company).toEqual({ name: 'EVERGREEN HARBOR BANCORP' });
  });

  it('reports a match on a former name, with the <em> tags stripped', () => {
    const record = normalizeInstitution({
      data: HARBOR_BANK,
      highlight: { 'PRIORNAME2.raw': ['<em>Puget</em> <em>Sound</em> Savings Bank'] },
    });
    expect(record.matched_on).toEqual({ field: 'former_name', text: 'Puget Sound Savings Bank' });
  });

  it('reports a trade-name match and keeps literal surrounding quotes verbatim', () => {
    const record = normalizeInstitution({
      data: HARBOR_BANK,
      highlight: { 'TE03N529.raw': ['"<em>Tideline</em> <em>Bank</em>"'] },
    });
    expect(record.matched_on).toEqual({ field: 'trade_name', text: '"Tideline Bank"' });
  });

  it('omits matched_on when the current name matched, even beside a former-name hit', () => {
    const record = normalizeInstitution({
      data: HARBOR_BANK,
      highlight: {
        'PRIORNAME1.raw': ['<em>Evergreen</em> Savings'],
        'NAME.raw': ['<em>Evergreen</em> Harbor Bank'],
      },
    });
    expect(record).not.toHaveProperty('matched_on');
  });

  it('ignores highlight keys that are not names (the TE*N528 website fields)', () => {
    const record = normalizeInstitution({
      data: HARBOR_BANK,
      highlight: { 'TE01N528.raw': ['www.<em>evergreen</em>.example'] },
    });
    expect(record).not.toHaveProperty('matched_on');
  });
});

describe('normalizeFailure', () => {
  it('normalizes a modern failure with an acquirer and a fractional loss estimate', () => {
    expect(normalizeFailure({ data: PA_FAILURE })).toEqual({
      failure_id: '4190',
      cert: 58321,
      fin: '10601',
      name: 'PINE RIVER STATE BANK',
      city: 'WINONA',
      state: 'MN',
      failed_on: '2025-03-14',
      resolved_on: '2025-03-14',
      resolution: 'FAILURE',
      method: 'PA',
      method_label: 'Purchase and assumption of all deposits',
      insurance_fund: 'DIF',
      charter_class: 'NM',
      total_assets: 412345,
      total_deposits: 398765,
      estimated_loss: 51234.567,
      estimated_loss_as_of: '2026-06-30',
      acquirer: { name: 'NORTHSTAR COMMUNITY BANK', city: 'ROCHESTER', state: 'MN' },
    });
  });

  it('drops null CERT, FIN "0", "0" acquirer fields, null RESDATE, COST, and QBFASSET, and a blank estimate date', () => {
    const record = normalizeFailure({ data: SPARSE_FAILURE });
    expect(record).toEqual({
      failure_id: '212',
      name: 'THE PRAIRIE STATE BANK',
      city: 'LISBON',
      state: 'ND',
      failed_on: '1937-08-14',
      resolution: 'FAILURE',
      method: 'PO',
      method_label: 'Payout',
      insurance_fund: 'FDIC',
      charter_class: 'NM',
      total_deposits: 41,
    });
  });

  it('treats an omitted QBFASSET, QBFDEP, or COST key the same as a null one', () => {
    const { QBFASSET: _a, QBFDEP: _d, COST: _c, ...omitted } = PA_FAILURE;
    const record = normalizeFailure({ data: omitted });
    for (const key of ['total_assets', 'total_deposits', 'estimated_loss']) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it('keeps a real zero loss estimate', () => {
    expect(normalizeFailure({ data: ZERO_COST_FAILURE }).estimated_loss).toBe(0);
  });

  it('keeps an acquirer name when only its city and state are "0"', () => {
    const record = normalizeFailure({
      data: { ...PA_FAILURE, BIDCITY: '0', BIDSTATE: '0' },
    });
    expect(record.acquirer).toEqual({ name: 'NORTHSTAR COMMUNITY BANK' });
  });

  it('labels the undocumented OBAM assistance code', () => {
    const record = normalizeFailure({ data: ASSISTANCE_EVENT });
    expect(record.method_label).toMatch(/Undocumented/);
    expect(record).not.toHaveProperty('estimated_loss');
    expect(record).not.toHaveProperty('acquirer');
  });
});

describe('metricValues', () => {
  it('nulls an exact 0 on zero-means-unreported ratios and keeps 0 elsewhere', () => {
    const data = { IDT1CER: 0, RBCRWAJ: 0, RBC1AAJ: 9.8, NCLNLSR: 0, ESTINS: 0, ROAQ: -0.5 };
    expect(
      metricValues(data, [
        'cet1_ratio',
        'total_risk_based_capital_ratio',
        'leverage_ratio',
        'noncurrent_loan_rate',
        'insured_deposit_share',
        'roa',
      ]),
    ).toEqual({
      cet1_ratio: null,
      total_risk_based_capital_ratio: null,
      leverage_ratio: 9.8,
      noncurrent_loan_rate: 0,
      insured_deposit_share: null,
      roa: -0.5,
    });
  });

  it('reads a field FDIC omitted as null', () => {
    expect(metricValues({ ASSET: 10 }, ['total_assets', 'brokered_deposits'])).toEqual({
      total_assets: 10,
      brokered_deposits: null,
    });
  });
});
