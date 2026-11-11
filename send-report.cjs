// Send one completion email after every attempted storefront check.
// The Brevo API key is provided only through GitHub Actions secrets.
const fs = require('node:fs');
const file = 'monitor-results/results.json';
const recipient = 'kim@kimscandycottage.com';
const key = process.env.BREVO_API_KEY;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID
  : '';
const localTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short'
}).format(new Date());
let results = [];
let readError = '';
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.results)) throw new Error('Missing results array');
  results = parsed.results;
} catch (err) {
  readError = 'Browser results unavailable: ' + err.message;
}
const failed = results.filter(r => r.status === 'failure');
const uncertain = results.filter(r => r.status === 'inconclusive');
const expected = results.filter(r => /^expected-/.test(r.status));
const verified = results.filter(r => r.status === 'verified');
const outcome = readError || !results.length ? 'INCONCLUSIVE'
  : failed.length ? 'FAILED'
  : uncertain.length ? 'INCONCLUSIVE'
  : 'PASSED';
const lines = [
  'Kim\'s Candy Cottage — Daily Storefront Check',
  'Result: ' + outcome,
  'Checked: ' + localTime + ' Eastern',
  '',
  ...results.map(r => (r.status === 'verified' ? 'PASS' : r.status.startsWith('expected-') ? 'EXPECTED' : r.status.toUpperCase())
    + ' — ' + r.label + (r.reason ? ' — ' + r.reason : '') + (r.error ? ' — ' + r.error : '')),
  ...(readError ? ['', readError] : []),
  '',
  'Verified: ' + verified.length + ' | Expected exceptions: ' + expected.length
    + ' | Failed: ' + failed.length + ' | Inconclusive: ' + uncertain.length,
  ...(runUrl ? ['', 'GitHub run and screenshots: ' + runUrl] : []),
  '',
  'Note: A missing scheduled GitHub run cannot send this email. A separate missed-run watchdog is still needed.'
];
async function main() {
  if (!key) throw new Error('BREVO_API_KEY repository secret is missing');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'KCC Storefront Monitor', email: recipient },
      to: [{ email: recipient }],
      subject: 'KCC Storefront Check — ' + outcome + ' — ' + localTime,
      textContent: lines.join('\n')
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error('Brevo rejected email (HTTP ' + response.status + '): ' + body.slice(0, 400));
  }
  console.log('Brevo accepted ' + outcome + ' report for ' + recipient + '. Check inbox for delivery.');
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
