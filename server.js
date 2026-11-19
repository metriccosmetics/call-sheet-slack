const { App } = require('@slack/bolt');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    { path: '/', method: ['GET'], handler: (req, res) => { res.writeHead(200); res.end('Metric Call Sheets is running'); } },
  ],
});

/* ---------- helpers ---------- */
const UA = { 'User-Agent': 'MetricCallSheetBot/1.0 (' + (process.env.CONTACT_EMAIL || 'contact-not-set') + ')' };
const clean = s => String(s || '').replace(/[^\x09\x0A\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2022]/g, '');

async function jget(url, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const fmtTime = v => {
  if (!v) return '';
  let [h, m] = v.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
};
const fmtDate = v => v ? new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
const todayPT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

/* ---------- weather + hospital ---------- */
const WX = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 95: 'Thunderstorms' };

async function geocode(addr) {
  const g = await jget('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(addr));
  if (!g.length) throw new Error('address not found');
  return { lat: +g[0].lat, lon: +g[0].lon };
}

async function getWeather(lat, lon, date) {
  if (!date) return '';
  const w = await jget('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&start_date=' + date + '&end_date=' + date).catch(() => null);
  if (!w || !w.daily || !w.daily.time || !w.daily.time.length || w.daily.temperature_2m_max[0] == null) return 'Forecast not available for this date. Check again closer to the shoot.';
  const d = w.daily;
  return (WX[d.weathercode[0]] || 'Conditions vary') + '. High ' + Math.round(d.temperature_2m_max[0]) + ' F, low ' + Math.round(d.temperature_2m_min[0]) + ' F. Chance of precipitation: ' + (d.precipitation_probability_max[0] == null ? 'n/a' : d.precipitation_probability_max[0] + '%') + '.';
}

const OVP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter'];
const km = (lat, lon, la, lo) => Math.hypot((la - lat) * 111, (lo - lon) * 111 * Math.cos(lat * Math.PI / 180));
const fmtH = (name, street, city, phone, d) => (name || 'Hospital') + '\n' + ((street || city) ? (street ? street + ', ' : '') + city : 'Address: please add') + '\n' + (phone || 'Phone: please add') + '\nAbout ' + (d * 0.621).toFixed(1) + ' miles from location';

async function hospOverpass(lat, lon) {
  const q = '[out:json][timeout:15];(node[amenity=hospital](around:20000,' + lat + ',' + lon + ');way[amenity=hospital](around:20000,' + lat + ',' + lon + '););out center tags 40;';
  const r = await Promise.any(OVP.map(u => jget(u + '?data=' + encodeURIComponent(q), 13000).then(x => { if (!x || !x.elements) throw new Error('bad'); return x; })));
  let best = null, bd = 1e9;
  r.elements.forEach(e => {
    const t = e.tags || {};
    if (t.emergency === 'no') return;
    const la = e.lat || (e.center && e.center.lat), lo = e.lon || (e.center && e.center.lon);
    if (la == null) return;
    const d = km(lat, lon, la, lo);
    if (d < bd) { bd = d; best = e; }
  });
  if (!best) return null;
  const t = best.tags || {};
  return fmtH(t.name, ((t['addr:housenumber'] || '') + ' ' + (t['addr:street'] || '')).trim(), [t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(' '), t.phone || t['contact:phone'], bd);
}

async function hospNominatim(lat, lon) {
  const d = 0.25, vb = [lon - d, lat + d, lon + d, lat - d].join(',');
  const r = await jget('https://nominatim.openstreetmap.org/search?format=json&limit=15&addressdetails=1&bounded=1&viewbox=' + vb + '&q=hospital', 13000);
  let best = null, bd = 1e9;
  r.forEach(e => { const dist = km(lat, lon, +e.lat, +e.lon); if (dist < bd) { bd = dist; best = e; } });
  if (!best) return null;
  const a = best.address || {};
  return fmtH(best.name || a.amenity, ((a.house_number || '') + ' ' + (a.road || '')).trim(), [a.city || a.town || a.village, a.state, a.postcode].filter(Boolean).join(' '), '', bd);
}

async function getHospital(lat, lon) {
  try { const v = await hospOverpass(lat, lon); if (v) return v; } catch (e) { /* fall through */ }
  const v = await hospNominatim(lat, lon);
  return v || 'No hospital found nearby. Please add one manually.';
}

/* ---------- PDF ---------- */
const LOGO = path.join(__dirname, 'logo.png');

function drawTable(doc, x, y, colW, headers, rows, allowBreak) {
  const w = colW.reduce((a, b) => a + b, 0);
  const head = yy => {
    doc.rect(x, yy, w, 18).fill('#111111');
    let cx = x;
    headers.forEach((h, i) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5).text(h, cx + 6, yy + 5, { width: colW[i] - 12, lineBreak: false });
      cx += colW[i];
    });
    return yy + 18;
  };
  y = head(y);
  rows.forEach((row, ri) => {
    const h = Math.max(...row.map((c, i) => {
      doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      return doc.heightOfString(c.text || ' ', { width: colW[i] - 12 });
    })) + 10;
    if (allowBreak && y + h > 740) { doc.addPage(); y = head(36); }
    let cx = x;
    row.forEach((c, i) => {
      doc.rect(cx, y, colW[i], h).fillAndStroke(ri % 2 ? '#f7f7f5' : '#ffffff', '#dddddd');
      doc.fillColor('#222222').font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(c.text || '', cx + 6, y + 5, { width: colW[i] - 12 });
      cx += colW[i];
    });
    y += h;
  });
  return y;
}

function buildPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
    let added = 0;
    doc.on('pageAdded', () => added++);
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const M = 36, W = 540;

    // header band
    doc.rect(0, 0, 612, 96).fill('#111111');
    doc.fillColor('#d4a017').font('Helvetica-Bold').fontSize(10).text('CALL SHEET', M, 20, { lineBreak: false });
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text(d.project.toUpperCase(), M, 34, { width: 340, height: 30, ellipsis: true });
    doc.fillColor('#cccccc').font('Helvetica').fontSize(10).text('Call Sheet - ' + fmtDate(d.date), M, 70, { width: 340, lineBreak: false });
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text('Let\u2019s Get To Work', 350, 40, { width: 160, align: 'right', lineBreak: false });
    if (fs.existsSync(LOGO)) doc.image(LOGO, 520, 18, { width: 56 });

    // info bar
    const cols = [
      ['DATE', fmtDate(d.date)],
      ['LOCATION', [d.locName, d.locAddr].filter(Boolean).join('\n')],
      ['CREW CALL', fmtTime(d.call)],
      ['LEAD CONTACT', [d.leadName, d.leadRole, d.leadPhone].filter(Boolean).join('\n')],
    ];
    const cw = W / 4;
    doc.font('Helvetica').fontSize(8.5);
    const ih = Math.max(...cols.map(c => doc.heightOfString(c[1] || ' ', { width: cw - 16 }))) + 28;
    let y = 110;
    doc.rect(M, y, W, ih).fillAndStroke('#f3f3f1', '#dddddd');
    cols.forEach((c, i) => {
      const x = M + i * cw;
      if (i) doc.moveTo(x, y).lineTo(x, y + ih).strokeColor('#dddddd').stroke();
      doc.fillColor('#222222').font('Helvetica-Bold').fontSize(7.5).text(c[0], x + 8, y + 8, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).text(c[1], x + 8, y + 20, { width: cw - 16 });
    });
    y += ih + 18;

    // crew (left) and schedule (right)
    const lw = 262, rx = M + lw + 16;
    doc.fillColor('#222222').font('Helvetica-Bold').fontSize(11);
    doc.text('CREW', M, y, { lineBreak: false });
    doc.text('SCHEDULE', rx, y, { lineBreak: false });
    const ty = y + 18;
    const sEnd = drawTable(doc, rx, ty, [70, lw - 70], ['TIME', 'ACTIVITY'], d.sched.map(s => [{ text: s.t, bold: true }, { text: s.a }]), false);
    const before = added;
    const cEnd = drawTable(doc, M, ty, [84, lw - 84], ['NAME', 'ROLE / CALL'], d.crew.map(c => [{ text: c.n, bold: true }, { text: (c.r ? c.r + '\n' : '') + c.t + ' call' }]), true);
    y = (added > before ? cEnd : Math.max(cEnd, sEnd)) + 18;

    // weather, hospital, notes
    const section = (title, text) => {
      if (!text) return;
      doc.font('Helvetica').fontSize(9);
      const h = doc.heightOfString(text, { width: W - 20 }) + 16;
      if (y + h + 22 > 750) { doc.addPage(); y = 36; }
      doc.fillColor('#222222').font('Helvetica-Bold').fontSize(11).text(title, M, y, { lineBreak: false });
      y += 16;
      doc.rect(M, y, W, h).fillAndStroke('#f3f3f1', '#dddddd');
      doc.fillColor('#222222').font('Helvetica').fontSize(9).text(text, M + 10, y + 8, { width: W - 20 });
      y += h + 14;
    };
    section('WEATHER', d.weather);
    section('NEAREST HOSPITAL', d.hospital);
    section('NOTES', d.notes);

    doc.end();
  });
}

/* ---------- Slack modal ---------- */
const field = (id, label, o = {}) => ({
  type: 'input', block_id: id, optional: !!o.optional,
  label: { type: 'plain_text', text: label },
  element: Object.assign(
    { type: 'plain_text_input', action_id: id, multiline: !!o.multiline },
    o.placeholder ? { placeholder: { type: 'plain_text', text: o.placeholder } } : {}
  ),
});

function modal(meta) {
  return {
    type: 'modal',
    callback_id: 'callsheet_modal',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Metric Call Sheet' },
    submit: { type: 'plain_text', text: 'Generate PDF' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      field('project', 'Project / client name', { placeholder: 'Roblox Production' }),
      { type: 'input', block_id: 'date', label: { type: 'plain_text', text: 'Shoot date' }, element: { type: 'datepicker', action_id: 'date', initial_date: todayPT() } },
      field('locName', 'Location name', { placeholder: 'Roblox Headquarters' }),
      field('locAddr', 'Location address', { placeholder: '2750 South Delaware Street, San Mateo, CA 94403' }),
      { type: 'input', block_id: 'crewCall', label: { type: 'plain_text', text: 'General crew call' }, element: { type: 'timepicker', action_id: 'crewCall', initial_time: '06:15' } },
      field('leadName', 'Lead contact name', { placeholder: 'Seth' }),
      field('leadRole', 'Lead contact role', { placeholder: 'Main point of contact / producer' }),
      field('leadPhone', 'Lead contact phone', { optional: true, placeholder: '555-555-5555' }),
      field('crew', 'Crew (one per line: Name, Role, optional call time)', { multiline: true, placeholder: 'Seth, Producer\nDorian, DP, 6:00 AM\nAlen, Camera' }),
      field('sched', 'Schedule (one per line: Time - Activity)', { multiline: true, placeholder: '6:15 AM - Crew arrival\n6:15 AM-4:00 PM - Shoot block\n4:00 PM - Estimated crew out' }),
      field('weather', 'Weather (leave blank to auto-fill)', { optional: true }),
      field('hospital', 'Nearest hospital (leave blank to auto-fill)', { optional: true, multiline: true }),
      field('notes', 'Notes', { optional: true, multiline: true, placeholder: 'Parking, load-in, wardrobe, etc.' }),
    ],
  };
}

const val = (v, id) => { const x = v[id] && v[id][id]; return x ? (x.value ?? x.selected_date ?? x.selected_time ?? '') : ''; };

function parseCrew(text, call) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const p = l.split(',').map(s => s.trim());
    return { n: p[0], r: p[1] || '', t: p[2] || call };
  });
}
function parseSched(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)\s+[-\u2013\u2014]\s+(.*)$/);
    return m ? { t: m[1], a: m[2] } : { t: '', a: l };
  });
}

async function postPdf(client, channel, user, buf, filename, comment) {
  try {
    await client.conversations.join({ channel }).catch(() => {});
    await client.filesUploadV2({ channel_id: channel, file: buf, filename, initial_comment: comment });
    return;
  } catch (e) { console.error('channel upload failed', e.data || e.message); }
  const dm = await client.conversations.open({ users: user });
  await client.filesUploadV2({ channel_id: dm.channel.id, file: buf, filename, initial_comment: comment + '\n_Posted here because I could not post in the original channel. Invite me there with /invite @Call Sheets._' });
}

/* ---------- Slack handlers ---------- */
app.command('/callsheet', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({ trigger_id: body.trigger_id, view: modal({ channel: body.channel_id, user: body.user_id }) });
});

app.view('callsheet_modal', async ({ ack, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  try {
    const v = view.state.values;
    const g = id => clean(val(v, id)).trim();
    const d = {
      project: g('project'), date: g('date'), locName: g('locName'), locAddr: g('locAddr'), call: g('crewCall'),
      leadName: g('leadName'), leadRole: g('leadRole'), leadPhone: g('leadPhone'),
      weather: g('weather'), hospital: g('hospital'), notes: g('notes'),
    };
    d.crew = parseCrew(clean(val(v, 'crew')), fmtTime(d.call));
    d.sched = parseSched(clean(val(v, 'sched')));
    const warnings = [];
    if (d.sched.length > 22) { d.sched = d.sched.slice(0, 22); warnings.push('Schedule was trimmed to 22 rows.'); }

    // auto-fill weather and hospital from the address
    const auto = {};
    let pos = null;
    if (!d.weather || !d.hospital) { try { pos = await geocode(d.locAddr); } catch (e) { warnings.push('Could not find that address, so weather and hospital were not auto-filled.'); } }
    const tasks = [];
    if (pos && !d.weather) tasks.push(getWeather(pos.lat, pos.lon, d.date).then(x => { d.weather = x; auto.weather = true; }).catch(() => warnings.push('Weather lookup failed.')));
    if (pos && !d.hospital) tasks.push(getHospital(pos.lat, pos.lon).then(x => { d.hospital = x; auto.hospital = true; }).catch(() => warnings.push('Hospital lookup failed. Add one before sharing.')));
    await Promise.all(tasks);

    const pdf = await buildPdf(d);
    const filename = (d.project + '-Call-Sheet-' + d.date).replace(/[^A-Za-z0-9-]+/g, '-') + '.pdf';

    const lines = ['Call sheet ready for *' + d.project + '* (' + fmtDate(d.date) + '), requested by <@' + meta.user + '>.'];
    if (auto.hospital || auto.weather) lines.push(':warning: Please confirm before sharing:');
    if (auto.hospital) lines.push('\u2022 *Hospital (auto-filled):* ' + d.hospital.replace(/\n/g, ' | '));
    if (auto.weather) lines.push('\u2022 *Weather (auto-filled):* ' + d.weather);
    warnings.forEach(w => lines.push(':information_source: ' + w));

    await postPdf(client, meta.channel, meta.user, pdf, filename, lines.join('\n'));
  } catch (e) {
    console.error(e);
    await client.chat.postMessage({ channel: meta.user, text: 'Sorry, I could not build that call sheet: ' + (e.message || 'unknown error') + '. Please try /callsheet again.' }).catch(() => {});
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Metric Call Sheets is running');
})();
