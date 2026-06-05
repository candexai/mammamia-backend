/**
 * Batch-test appointment extraction via Python POST /api/v1/automation/extract-data
 * (same path the automation engine uses).
 *
 * Usage:
 *   node src/scripts/test-appointment-extraction-batch.js
 *   node src/scripts/test-appointment-extraction-batch.js conv_abc conv_def
 *   ORG_ID=69ca55bef0174d1308e92b6d node src/scripts/test-appointment-extraction-batch.js
 *
 * Env:
 *   PYTHON_API_URL — default https://eleven.candexai.co.in (shared Python service)
 */

require('dotenv').config();

const DEFAULT_CONVERSATION_IDS = [
  'conv_5801krpnm72rec49cxmfgnjkm5b5',
  'conv_1801krp53adxegmtknb3fbs6vre2',
  'conv_5701krqnvzzefcpanz545f43byqg'
];

/** Amar / template schema (tested) */
const SCHEMA_APPOINTMENT = {
  extraction_prompt: 'Extract whether a person booked an apppoinment or not',
  json_example: {
    appointment_booked: 'True',
    appointment_date: '2026-05-20',
    appointment_time: '14:30'
  }
};

/** Agent-style schema (date/time/address/budget — like your screenshot) */
const SCHEMA_AGENT_TRIP = {
  extraction_prompt:
    'Extract the date, time, address/location, and budget for the trip from the call transcript.',
  json_example: {
    date: '',
    time: '',
    address: '',
    budget: null
  }
};

function cleanStr(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : '';
}

function summarizeBooked(result) {
  const ed = result.extracted_data || {};
  const date =
    cleanStr(ed.appointment_date) ||
    cleanStr(ed.date) ||
    cleanStr(result.date);
  const time =
    cleanStr(ed.appointment_time) ||
    cleanStr(ed.time) ||
    cleanStr(result.time);
  const bookedRaw = ed.appointment_booked ?? result.appointment_booked;

  const { resolveFinalAppointmentBooked } = require('../../dist/services/automation.service');
  const booked = resolveFinalAppointmentBooked(bookedRaw, date, time);

  return { booked, date, time, bookedRaw, extracted_data: ed };
}

async function runOne(automationService, conversationId, schema, label) {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Conversation: ${conversationId}`);
  console.log(`Schema: ${label}`);
  console.log('─'.repeat(72));

  try {
    const result = await automationService.extractConversationDataViaPythonApi(
      conversationId,
      'appointment',
      {
        extraction_prompt: schema.extraction_prompt,
        json_example: schema.json_example
      }
    );

    const summary = summarizeBooked(result);
    console.log('Raw extracted_data:', JSON.stringify(summary.extracted_data, null, 2));
    console.log(
      summary.booked
        ? `✅ BOOKED — date=${summary.date} time=${summary.time} (raw booked=${JSON.stringify(summary.bookedRaw)})`
        : `❌ NOT BOOKED — date=${summary.date || '(empty)'} time=${summary.time || '(empty)'} (raw booked=${JSON.stringify(summary.bookedRaw)})`
    );
    return { conversationId, schema: label, ...summary, success: true };
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    console.log(`❌ ERROR: ${msg}`);
    return { conversationId, schema: label, success: false, error: msg };
  }
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => a.startsWith('conv_'));
  const conversationIds = ids.length > 0 ? ids : DEFAULT_CONVERSATION_IDS;

  const { automationService } = require('../../dist/services/automation.service');

  console.log('='.repeat(72));
  console.log('Appointment extraction batch test (Python extract-data API)');
  console.log('PYTHON_API_URL:', process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://eleven.candexai.co.in');
  console.log('Conversations:', conversationIds.join(', '));
  console.log('='.repeat(72));

  const rows = [];

  for (const id of conversationIds) {
    rows.push(await runOne(automationService, id, SCHEMA_APPOINTMENT, 'appointment_booked schema'));
    rows.push(await runOne(automationService, id, SCHEMA_AGENT_TRIP, 'agent trip schema (date/time/address/budget)'));
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('SUMMARY');
  console.log('='.repeat(72));
  console.table(
    rows.map((r) => ({
      conversation: r.conversationId,
      schema: r.schema,
      booked: r.success ? (r.booked ? 'YES' : 'NO') : 'ERROR',
      date: r.date || '',
      time: r.time || '',
      error: r.error || ''
    }))
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
