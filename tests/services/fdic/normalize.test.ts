/**
 * @fileoverview Tests for the BankFind row normalizers over recorded-shape rows:
 * numeric coercion, ISO dates, blanks and absence sentinels dropped to absent,
 * zero-means-unreported ratios nulled, and `/history` rows turned into events —
 * the one-event-per-exit pairing rule, role and counterparty, recorded changes,
 * and newest-first order.
 * @module tests/services/fdic/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  historyEvents,
  historyRow,
  metricValues,
  normalizeFailure,
  normalizeInstitution,
  num,
  str,
} from '@/services/fdic/normalize.js';
import type { HistoryRow } from '@/services/fdic/types.js';
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
import { HISTORY } from '../../helpers/fake-fdic.js';

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

/** Raw `/history` data as the row the service reads; fails the test on a malformed row. */
function rows(...data: Record<string, unknown>[]): HistoryRow[] {
  return data.map((d) => {
    const row = historyRow({ data: { ...d } });
    if (!row) throw new Error(`Malformed history fixture ${JSON.stringify(d)}`);
    return row;
  });
}

describe('historyRow', () => {
  it('keeps the ID, the ISO effective date, the code, and the label verbatim', () => {
    expect(historyRow({ data: { ...HISTORY.svbFailure } })).toMatchObject({
      id: '2023009929_211_17167_655043_17167',
      effectiveDate: '2023-03-10',
      changeCode: 211,
      changeDescription: 'Failure - Whole Institution',
    });
  });

  it.each(['ID', 'EFFDATE', 'CHANGECODE', 'CHANGECODE_DESC'])(
    'rejects a row without %s',
    (field) => {
      const data: Record<string, unknown> = { ...HISTORY.svbFailure, [field]: '' };
      expect(historyRow({ data })).toBeUndefined();
    },
  );
});

describe('historyEvents: one event per exit', () => {
  it('keeps the outgoing row of a two-sided merger, seen from the outgoing bank', () => {
    const events = historyEvents(867, rows(HISTORY.truistMergerSurvivor, HISTORY.truistMerger), []);
    expect(events).toEqual([
      {
        effective_date: '2019-12-07',
        event_type: 'merger',
        change_code: 223,
        change_description: 'Merger -Without Assistance',
        role: 'outgoing',
        counterparty: { cert: 9846, name: 'Truist Bank' },
        transaction_number: 201911532,
      },
    ]);
  });

  it('keeps the outgoing row of the same merger seen from the survivor, without the FRM_ fields as changes', () => {
    const events = historyEvents(
      9846,
      rows(HISTORY.truistMerger, HISTORY.truistMergerSurvivor),
      [],
    );
    expect(events).toEqual([
      {
        effective_date: '2019-12-07',
        event_type: 'merger',
        change_code: 223,
        change_description: 'Merger -Without Assistance',
        role: 'survivor',
        counterparty: { cert: 867, name: 'SunTrust Bank' },
        transaction_number: 201911532,
      },
    ]);
  });

  it('pairs a failure whose outgoing row carries no CERT (211) and drops the 811 twin', () => {
    const pair = rows(HISTORY.svbFailure, HISTORY.svbFailureSurvivor);
    expect(historyEvents(24735, pair, [])).toEqual([
      expect.objectContaining({
        event_type: 'failure_or_assistance',
        change_code: 211,
        role: 'outgoing',
        counterparty: { cert: 59331, name: 'Deposit Insurance National Bank of Santa Clara' },
      }),
    ]);
    expect(historyEvents(59331, pair, [])).toEqual([
      expect.objectContaining({
        change_code: 211,
        role: 'survivor',
        counterparty: { cert: 24735, name: 'Silicon Valley Bank' },
      }),
    ]);
  });

  it('pairs an affiliated merger (224, no CERT on the outgoing row) as one merger', () => {
    const pair = rows(HISTORY.affiliatedMergerSurvivor, HISTORY.affiliatedMerger);
    expect(historyEvents(3510, pair, [])).toEqual([
      expect.objectContaining({
        event_type: 'merger',
        change_code: 224,
        role: 'survivor',
        counterparty: { cert: 58026, name: 'Recontrust Company, National Association' },
      }),
    ]);
    expect(historyEvents(58026, pair, [])).toEqual([
      expect.objectContaining({ change_code: 224, role: 'outgoing' }),
    ]);
  });

  it('classifies a failed-bank takeover by the outgoing row, keeping its code on the survivor side', () => {
    for (const order of [
      [HISTORY.firstRepublicSurvivor, HISTORY.firstRepublicFailure],
      [HISTORY.firstRepublicFailure, HISTORY.firstRepublicSurvivor],
    ]) {
      expect(historyEvents(628, rows(...order), [])).toEqual([
        {
          effective_date: '2023-05-01',
          event_type: 'failure_or_assistance',
          change_code: 211,
          change_description: 'Failure - Whole Institution',
          role: 'survivor',
          counterparty: { cert: 59017, name: 'First Republic Bank' },
          transaction_number: 2023160984,
        },
      ]);
    }
  });

  it('keeps an exit recorded only on the survivor side (810 without an outgoing partner) once', () => {
    const lone = rows(HISTORY.survivorSideOnly);
    expect(historyEvents(4827, lone, [])).toEqual([
      expect.objectContaining({
        event_type: 'merger',
        change_code: 810,
        role: 'outgoing',
        counterparty: { cert: 4857, name: 'The First National Bank of Oakland' },
      }),
    ]);
    expect(historyEvents(4857, lone, [])).toEqual([
      expect.objectContaining({
        role: 'survivor',
        counterparty: { cert: 4827, name: 'The First National Bank of Barton' },
      }),
    ]);
  });

  it('keeps an outgoing-side row (223) with no survivor row in the response once', () => {
    expect(historyEvents(19700, rows(HISTORY.outgoingSideOnly), [])).toEqual([
      expect.objectContaining({
        event_type: 'merger',
        change_code: 223,
        role: 'survivor',
        counterparty: { cert: 19442, name: 'Island State Bank' },
      }),
    ]);
  });

  /** 19700's side of transaction 910005375, which FDIC recorded without OUT_CERT. */
  const survivorWithoutOutgoing = {
    ID: '910005375_810_13499_13499_16723',
    TRANSNUM: 910005375,
    CERT: 19700,
    CHANGECODE: 810,
    CHANGECODE_DESC: 'Participated in Absorbtion/Consolidation/Merger',
    EFFDATE: '1991-05-08T00:00:00',
    SUR_CERT: 19700,
    SUR_INSTNAME: 'The International Bank',
    ACQ_CERT: 19700,
    ACQ_INSTNAME: 'The International Bank',
  };

  it('pairs a survivor-side 810 without OUT_CERT with the outgoing row of its transaction that names it survivor', () => {
    for (const order of [
      [survivorWithoutOutgoing, HISTORY.outgoingSideOnly],
      [HISTORY.outgoingSideOnly, survivorWithoutOutgoing],
    ]) {
      expect(historyEvents(19700, rows(...order), [])).toEqual([
        {
          effective_date: '1991-05-08',
          event_type: 'merger',
          change_code: 223,
          change_description: 'Merger -Without Assistance',
          role: 'survivor',
          counterparty: { cert: 19442, name: 'Island State Bank' },
          transaction_number: 910005375,
        },
      ]);
    }
    const pair = rows(HISTORY.outgoingSideOnly, survivorWithoutOutgoing);
    expect(historyEvents(19442, pair, []).map((e) => [e.change_code, e.role])).toEqual([
      [223, 'outgoing'],
    ]);
  });

  it.each([
    ['another transaction', { TRANSNUM: 910005376 }],
    ['another survivor', { SUR_CERT: 19701 }],
  ])('keeps a survivor-side 810 without OUT_CERT apart from an outgoing row of %s', (_, differ) => {
    const events = historyEvents(
      19700,
      rows(survivorWithoutOutgoing, { ...HISTORY.outgoingSideOnly, ...differ }),
      [],
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.change_code, e.counterparty?.cert])).toEqual(
      expect.arrayContaining([
        [810, undefined],
        [223, 19442],
      ]),
    );
  });

  it('keeps a survivor-side row without OUT_CERT on its own, with no counterparty', () => {
    const events = historyEvents(
      628,
      rows(
        HISTORY.assistedWithoutOutgoing,
        HISTORY.firstRepublicSurvivor,
        HISTORY.firstRepublicFailure,
      ),
      [],
    );
    expect(events.map((e) => [e.change_code, e.role, e.counterparty])).toEqual([
      [211, 'survivor', { cert: 59017, name: 'First Republic Bank' }],
      [811, 'survivor', undefined],
    ]);
    expect(events[1]).not.toHaveProperty('counterparty');
  });
});

describe('historyEvents: roles, counterparties, and changes', () => {
  it('reads a branch purchase as buyer (counterparty the seller) or seller (counterparty the buyer)', () => {
    const events = historyEvents(867, rows(HISTORY.branchPurchase, HISTORY.branchSale), []);
    expect(events.map((e) => [e.event_type, e.role, e.counterparty])).toEqual([
      ['branch_purchase', 'buyer', { cert: 22238, name: 'Omni National Bank' }],
      ['branch_purchase', 'seller', { cert: 28838, name: 'FloridaFirst Bank' }],
    ]);
    // The FRM_ fields of a purchase row describe the seller, not a change to 867.
    expect(events[0]).not.toHaveProperty('changes');
  });

  it('names the former certificate of a code 150 CERT change and lists only the attributes that differ', () => {
    expect(historyEvents(20442, rows(HISTORY.certReplaced), [])).toEqual([
      {
        effective_date: '1971-06-17',
        event_type: 'charter_change',
        change_code: 150,
        change_description: 'Cert Changed from Old Cert by Administrative Order',
        role: 'subject',
        counterparty: { cert: 90054, name: 'Meriden Trust & Safe Deposit Company' },
        changes: {
          name: {
            from: 'Meriden Trust & Safe Deposit Company',
            to: 'The Meriden Trust and Safe Deposit Company',
          },
          bank_class: { from: 'NC', to: 'NM' },
          regulator: { from: 'STATE', to: 'FDIC' },
        },
      },
    ]);
  });

  it('lists a rename with the address and city that moved in the same row, and nothing that stayed', () => {
    const [rename] = historyEvents(9846, rows(HISTORY.truistRename), []);
    expect(rename).toMatchObject({ event_type: 'name_change', role: 'subject' });
    expect(rename?.changes).toEqual({
      name: { from: 'Branch Banking and Trust Company', to: 'Truist Bank' },
      address: { from: '200 W 2nd St', to: '214 N Tryon St' },
      city: { from: 'Winston Salem', to: 'Charlotte' },
    });
    expect(rename).not.toHaveProperty('counterparty');
  });

  it('leaves changes absent when one side of an attribute is unrecorded or nothing differs', () => {
    const [opening] = historyEvents(
      24735,
      rows({
        ...HISTORY.svbRelocation,
        CHANGECODE: 110,
        CHANGECODE_DESC: 'New Institution',
        FRM_PADDR: '',
      }),
      [],
    );
    expect(opening).toMatchObject({ event_type: 'opening', role: 'subject' });
    expect(opening).not.toHaveProperty('changes');
  });

  it('reads a branch-level row as a branch event of the office, with its own before and after', () => {
    expect(historyEvents(3511, [], rows(HISTORY.branchRelocation))).toEqual([
      {
        effective_date: '2026-09-28',
        event_type: 'branch',
        change_code: 520,
        change_description: 'Change in Physical Location (FO or BR)',
        role: 'subject',
        changes: { address: { from: '100 E FLAGLER ST', to: '550 NW 1ST AVE' } },
        branch: {
          name: 'EAST FLAGLER STREET BRANCH',
          number: 7442,
          address: '550 NW 1ST AVE',
          city: 'MIAMI',
          state: 'FL',
        },
        transaction_number: 2026028320,
      },
    ]);
  });

  it('leaves blank strings, missing CERTs, and TRANSNUM 0 absent, never 0 or ""', () => {
    const [event] = historyEvents(
      867,
      rows({
        ...HISTORY.truistMerger,
        TRANSNUM: 0,
        SUR_CERT: null,
        SUR_INSTNAME: '   ',
      }),
      [],
    );
    expect(event).toEqual({
      effective_date: '2019-12-07',
      event_type: 'merger',
      change_code: 223,
      change_description: 'Merger -Without Assistance',
      role: 'outgoing',
    });
    const [office] = historyEvents(
      3511,
      [],
      rows({
        ...HISTORY.branchRelocation,
        OFF_NAME: '',
        OFF_NUM: null,
        OFF_PADDR: '',
        OFF_PCITY: '',
        OFF_PSTALP: '',
      }),
    );
    expect(office).not.toHaveProperty('branch');
    expect(office).not.toHaveProperty('changes');
  });

  it('classifies a code missing from the table as other', () => {
    const [event] = historyEvents(
      24735,
      rows({ ...HISTORY.svbRelocation, CHANGECODE: 999, CHANGECODE_DESC: 'New Code' }),
      [],
    );
    expect(event).toMatchObject({
      event_type: 'other',
      change_code: 999,
      change_description: 'New Code',
      role: 'subject',
    });
  });
});

describe('historyEvents: order', () => {
  it('orders newest first by effective date, then transaction number, then ID, across both levels', () => {
    const institution = rows(
      HISTORY.truistRename,
      {
        ...HISTORY.truistRename,
        ID: '201911532_520_6300__',
        CHANGECODE: 520,
        CHANGECODE_DESC: 'Change in Physical Location (FO or BR)',
      },
      { ...HISTORY.truistRename, ID: 'z_earlier_transaction', TRANSNUM: 201900001 },
      HISTORY.branchPurchase,
    );
    const branch = rows({
      ...HISTORY.branchRelocation,
      CERT: 9846,
      EFFDATE: '2019-12-08T00:00:00',
    });
    expect(
      historyEvents(9846, institution, branch).map((e) => [
        e.effective_date,
        e.change_code,
        e.transaction_number,
      ]),
    ).toEqual([
      ['2019-12-08', 520, 2026028320],
      ['2019-12-07', 520, 201911532],
      ['2019-12-07', 510, 201911532],
      ['2019-12-07', 510, 201900001],
      ['2009-03-27', 712, 201020269],
    ]);
  });
});
