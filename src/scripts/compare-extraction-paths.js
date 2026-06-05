/**
 * Compare raw Python extraction vs sheet automation normalization.
 *
 * Sheet path: Python result → buildNormalizedExtractionContext → appointment.booked
 * API test path: raw Python result returned by extractAppointmentForAutomation
 *
 * Usage:
 *   node src/scripts/compare-extraction-paths.js conv_abc conv_def
 *   node src/scripts/compare-extraction-paths.js   # uses default sample IDs
 *
 * Env: PYTHON_API_URL (default https://eleven.candexai.co.in)
 */

require('dotenv').config();

const DEFAULT_IDS = [
  'conv_7901kt8tgdqmfk5rq5b703chpah9',
  'conv_1801kt8thejceq39fnv0zzb666mc',
  'conv_5601kt8tnj3sexb85mjx9n123pkt',
  'conv_0601kt8v9vs6fkmbeg35zr6pwnza',
  'conv_8901kt8zp8mres0radd6ysdjjt9w'
];

const SCHEMA = {
  extraction_prompt: 'Extract whether a person booked an appointment or not',
  json_example: {
    appointment_booked: false,
    appointment_date: '',
    appointment_time: ''
  }
};

function rawBooked(result) {
  const ed = result.extracted_data || {};
  const v = ed.appointment_booked ?? result.appointment_booked;
  if (v === true || v === 'true' || v === 'True') return true;
  if (v === false || v === 'false' || v === 'False') return false;
  return v;
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => a.startsWith('conv_'));
  const conversationIds = ids.length > 0 ? ids : DEFAULT_IDS;

  const {
    automationService,
    buildNormalizedExtractionContext
  } = require('../../dist/services/automation.service');

  console.log('='.repeat(80));
  console.log('EXTRACTION PATH COMPARISON — raw Python vs sheet normalization');
  console.log('PYTHON_API_URL:', process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://eleven.candexai.co.in');
  console.log('Conversations:', conversationIds.join(', '));
  console.log('='.repeat(80));

  const rows = [];

  for (const conversationId of conversationIds) {
    console.log(`\n${'─'.repeat(80)}\n${conversationId}\n${'─'.repeat(80)}`);
    try {
      const raw = await automationService.extractAppointmentForAutomation(
        conversationId,
        '000000000000000000000000',
        { extraction_type: 'appointment', ...SCHEMA }
      );

      const normalized = buildNormalizedExtractionContext(raw, SCHEMA.json_example);
      const rawB = rawBooked(raw);
      const sheetB = normalized.finalBooked;
      const override = rawB !== sheetB ? 'YES' : 'no';

      console.log('Raw Python extracted_data:', JSON.stringify(raw.extracted_data || {}, null, 2));
      console.log(`Raw appointment_booked:     ${JSON.stringify(rawB)}`);
      console.log(`Sheet finalBooked:          ${sheetB}`);
      console.log(`Normalization override:     ${override}`);
      if (override === 'YES') {
        console.log('  Reason: resolveFinalAppointmentBooked rules (date/time present or missing)');
      }

      rows.push({
        conversationId,
        rawBooked: rawB,
        sheetBooked: sheetB,
        override,
        rawDate: (raw.extracted_data || {}).appointment_date || raw.date || '',
        sheetDate: normalized.finalDate,
        rawTime: (raw.extracted_data || {}).appointment_time || raw.time || '',
        sheetTime: normalized.finalTime
      });
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || err.message;
      console.log(`ERROR: ${msg}`);
      rows.push({ conversationId, error: msg });
    }
  }

  console.log(`\n${'='.repeat(80)}\nSUMMARY\n${'='.repeat(80)}`);
  console.table(
    rows.map((r) => ({
      conversation: r.conversationId,
      raw_booked: r.rawBooked ?? 'ERR',
      sheet_booked: r.sheetBooked ?? 'ERR',
      override: r.override ?? '-',
      error: r.error || ''
    }))
  );

  const overrides = rows.filter((r) => r.override === 'YES');
  if (overrides.length === 0) {
    console.log('\nNo normalization overrides for this sample — raw Python matches sheet path.');
  } else {
    console.log(`\n${overrides.length} conversation(s) where sheet normalization differs from raw Python.`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
