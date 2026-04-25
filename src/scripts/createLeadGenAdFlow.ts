/**
 * End-to-end test script: Meta Marketing API — Lead ads (campaign → ad set → lead form → creative → ad).
 * Docs: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/create/
 *
 * Required env (see .env.example block in comments at bottom):
 * - META_PAGE_ACCESS_TOKEN — Page token with ads_management, pages_manage_ads, pages_read_engagement, pages_show_list
 * - META_AD_ACCOUNT_ID — numeric ad account id (no "act_" prefix)
 * - META_PAGE_ID — Facebook Page id
 *
 * Optional:
 * - META_GRAPH_API_VERSION (default v25.0)
 * - META_IMAGE_HASH — if set, skips image upload
 * - META_IMAGE_PATH — local file path to upload via adimages (needs META_IMAGE_HASH xor META_IMAGE_PATH)
 * - META_TARGET_COUNTRIES — comma-separated ISO codes (default US)
 * - META_DAILY_BUDGET_CENTS — default 1000 ($10/day)
 * - META_BID_AMOUNT_CENTS — default 500
 * - META_ACTIVATE_AD — if "true", sets campaign + ad set + ad to ACTIVE at end (use with care)
 */

import axios from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function actAccountId(raw: string): string {
  const n = raw.replace(/^act_/, '');
  return `act_${n}`;
}

async function graphPost<T = { id: string }>(
  urlPath: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = requireEnv('META_PAGE_ACCESS_TOKEN');
  const payload = { ...body, access_token: token };
  const { data } = await axios.post<T>(`${BASE}${urlPath}`, payload, {
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (typeof data === 'object' && data && 'error' in data) {
    const err = (data as { error?: { message?: string; code?: number } }).error;
    throw new Error(`Graph API error ${urlPath}: ${err?.message || JSON.stringify(data)}`);
  }
  return data;
}

async function uploadAdImage(adAccountAct: string, imagePath: string): Promise<string> {
  const token = requireEnv('META_PAGE_ACCESS_TOKEN');
  const form = new FormData();
  form.append('filename', fs.createReadStream(imagePath));
  const { data } = await axios.post(`${BASE}/${adAccountAct}/adimages`, form, {
    headers: form.getHeaders(),
    params: { access_token: token },
    validateStatus: () => true
  });
  if (data?.error) {
    throw new Error(`adimages upload: ${data.error.message || JSON.stringify(data.error)}`);
  }
  const images = data?.images as Record<string, { hash?: string }> | undefined;
  const firstKey = images && Object.keys(images)[0];
  const imageHash = firstKey
    ? images![firstKey]?.hash || firstKey
    : undefined;
  if (!imageHash) {
    throw new Error(`Could not read image hash from adimages response: ${JSON.stringify(data)}`);
  }
  return imageHash;
}

async function main() {
  const adAccountRaw = requireEnv('META_AD_ACCOUNT_ID');
  const adAccountAct = actAccountId(adAccountRaw);
  const pageId = requireEnv('META_PAGE_ID');

  const dailyBudget = Number(process.env.META_DAILY_BUDGET_CENTS || 1000);
  const bidAmount = Number(process.env.META_BID_AMOUNT_CENTS || 500);
  const countries = (process.env.META_TARGET_COUNTRIES || 'US')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  const suffix = `-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

  console.log('\n--- Step 1: Create campaign (OUTCOME_LEADS, PAUSED) ---\n');
  const campaign = await graphPost(`/${adAccountAct}/campaigns`, {
    buying_type: 'AUCTION',
    name: `LeadGen Test Campaign${suffix}`,
    objective: 'OUTCOME_LEADS',
    special_ad_categories: ['NONE'],
    status: 'PAUSED'
  });
  const campaignId = campaign.id;
  console.log('campaign_id:', campaignId);

  console.log('\n--- Step 2: Create ad set (LEAD_GENERATION, ON_AD) ---\n');
  const targeting = {
    geo_locations: { countries },
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed']
  };

  const adSet = await graphPost(`/${adAccountAct}/adsets`, {
    name: `LeadGen Test Ad Set${suffix}`,
    campaign_id: campaignId,
    daily_budget: dailyBudget,
    billing_event: 'IMPRESSIONS',
    bid_amount: bidAmount,
    optimization_goal: 'LEAD_GENERATION',
    destination_type: 'ON_AD',
    promoted_object: { page_id: pageId },
    targeting,
    status: 'PAUSED'
  });
  const adSetId = adSet.id;
  console.log('adset_id:', adSetId);

  console.log('\n--- Step 3: Create lead form ---\n');
  const questions = [
    { type: 'FULL_NAME', key: 'q1' },
    { type: 'EMAIL', key: 'q2' },
    { type: 'PHONE', key: 'q3' },
    { type: 'CUSTOM', key: 'q4', label: 'Do you like rainbows?' },
    {
      type: 'CUSTOM',
      key: 'q5',
      label: 'What is your favorite color?',
      options: [
        { value: 'Red', key: 'opt1' },
        { value: 'Green', key: 'opt2' },
        { value: 'Blue', key: 'opt3' }
      ]
    }
  ];

  const formRes = await graphPost(`/${pageId}/leadgen_forms`, {
    name: `LeadGen Test Form${suffix}`,
    questions: JSON.stringify(questions)
  });
  const formId = formRes.id;
  console.log('leadgen_form_id:', formId);

  let imageHash = process.env.META_IMAGE_HASH?.trim();
  const imagePath = process.env.META_IMAGE_PATH?.trim();
  if (!imageHash) {
    if (!imagePath) {
      throw new Error('Set META_IMAGE_HASH or META_IMAGE_PATH (upload a 1.91:1 or square image for feed).');
    }
    console.log('\n--- Step 3b: Upload ad image ---\n');
    imageHash = await uploadAdImage(adAccountAct, path.resolve(imagePath));
    console.log('image_hash:', imageHash);
  } else {
    console.log('\n--- Using existing META_IMAGE_HASH ---\n');
  }

  console.log('\n--- Step 4: Create ad creative ---\n');
  const creative = await graphPost(`/${adAccountAct}/adcreatives`, {
    object_story_spec: {
      page_id: pageId,
      link_data: {
        link: 'https://fb.me/',
        message: `Test lead ad creative${suffix}`,
        description: 'API test — lead generation ad',
        image_hash: imageHash,
        call_to_action: {
          type: 'SIGN_UP',
          value: { lead_gen_form_id: formId }
        }
      }
    }
  });
  const creativeId = creative.id;
  console.log('creative_id:', creativeId);

  console.log('\n--- Step 5: Create ad ---\n');
  const ad = await graphPost(`/${adAccountAct}/ads`, {
    name: `LeadGen Test Ad${suffix}`,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED'
  });
  const adId = ad.id;
  console.log('ad_id:', adId);

  const activate = process.env.META_ACTIVATE_AD === 'true';
  if (activate) {
    console.log('\n--- Step 6: Activate (META_ACTIVATE_AD=true) ---\n');
    await graphPost(`/${campaignId}`, { status: 'ACTIVE' });
    await graphPost(`/${adSetId}`, { status: 'ACTIVE' });
    await graphPost(`/${adId}`, { status: 'ACTIVE' });
    console.log('Campaign, ad set, and ad set to ACTIVE. Meta will review before delivery.');
  } else {
    console.log('\n--- Done (all PAUSED). Review in Ads Manager or set META_ACTIVATE_AD=true to go live. ---\n');
  }

  console.log('\nSummary:');
  console.log(JSON.stringify({ campaignId, adSetId, formId, creativeId, adId, imageHash }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
