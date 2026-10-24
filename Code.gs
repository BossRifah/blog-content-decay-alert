/**
 * Blog content decay alert
 *
 * Checks the last 3 complete months of Search Console and GA4 data per blog URL.
 * If any one of impressions, sessions, or position has declined across those 3 months
 * past the thresholds below, sends a Slack alert listing the affected blogs.
 *
 * Runs on the 1st of each month once the trigger is set up (see createMonthlyTrigger).
 */

const CONFIG = {
  GSC_SITE_URL: PropertiesService.getScriptProperties().getProperty('GSC_SITE_URL'),           // must match the property exactly as it appears in Search Console
  GA4_PROPERTY_ID: PropertiesService.getScriptProperties().getProperty('GA4_PROPERTY_ID'),                  // numeric GA4 property id, no "properties/" prefix
  SLACK_WEBHOOK_URL: PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL'),
  BLOG_PATH_PREFIX: '/blog/',                    // only urls containing this are considered, adjust or set to '' to include everything
  IMPRESSIONS_DECLINE_PCT: 0.15,                 // 15% cumulative decline from month 1 to month 3
  TRAFFIC_DECLINE_PCT: 0.15,
  POSITION_DECLINE: 3,                           // average position worse by this many spots or more
  REQUIRE_MONOTONIC: true,                       // if true, each month must be worse than the one before, not just the net change
  MAX_BLOGS_PER_ALERT: 7                         // only the top N blogs, ranked by priority, are sent each run
};

function checkDecliningBlogs() {
  validateConfig();
  const months = getLastThreeCompleteMonths();
  const gscData = {};
  const ga4Data = {};

  months.forEach(m => {
    gscData[m.label] = fetchSearchConsoleData(m.start, m.end);
    ga4Data[m.label] = fetchGA4Data(m.start, m.end);
  });

  const combined = combineData(months, gscData, ga4Data);
  const flagged = findDecliningBlogs(combined);

  if (flagged.length > 0) {
    Logger.log(flagged.length + ' blogs qualified this run, sending the top ' + Math.min(flagged.length, CONFIG.MAX_BLOGS_PER_ALERT) + '.');
    const topBlogs = flagged.slice(0, CONFIG.MAX_BLOGS_PER_ALERT);
    sendSlackAlert(topBlogs, months, flagged.length);
  } else {
    Logger.log('No declining blogs found this run.');
  }
}

function getLastThreeCompleteMonths() {
  // if today is August 1st, this returns May, June, July
  const now = new Date();
  const months = [];
  for (let i = 3; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); // last day of that month
    months.push({
      label: Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM'),
      start: Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      end: Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    });
  }
  return months;
}

function fetchSearchConsoleData(startDate, endDate) {
  // Search Console has no advanced service in Apps Script, so this calls the REST
  // API directly, the same way fetchGA4Data does. Requires the webmasters.readonly
  // scope in the manifest.
  const encodedSiteUrl = encodeURIComponent(CONFIG.GSC_SITE_URL);
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodedSiteUrl + '/searchAnalytics/query';
  const payload = {
    startDate: startDate,
    endDate: endDate,
    dimensions: ['page'],
    rowLimit: 5000
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(response.getContentText());
  const rows = json.rows || [];
  const result = {};
  rows.forEach(row => {
    const pageUrl = row.keys[0];
    if (CONFIG.BLOG_PATH_PREFIX && pageUrl.indexOf(CONFIG.BLOG_PATH_PREFIX) === -1) return;
    result[normalizeUrl(pageUrl)] = {
      impressions: row.impressions,
      position: row.position
    };
  });
  return result;
}

function fetchGA4Data(startDate, endDate) {
  // uses the GA4 Data API directly, requires the analytics.readonly scope and the
  // Google Analytics Data API enabled on the script's linked Google Cloud project
  const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + CONFIG.GA4_PROPERTY_ID + ':runReport';
  const payload = {
    dateRanges: [{ startDate: startDate, endDate: endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'sessions' }],
    limit: 10000
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(response.getContentText());
  const result = {};
  if (!json.rows) return result;
  json.rows.forEach(row => {
    const path = row.dimensionValues[0].value;
    if (CONFIG.BLOG_PATH_PREFIX && path.indexOf(CONFIG.BLOG_PATH_PREFIX) === -1) return;
    result[normalizeUrl(path)] = {
      sessions: Number(row.metricValues[0].value)
    };
  });
  return result;
}

function normalizeUrl(rawUrl) {
  // strips the domain and trailing slash so full GSC urls and GA4 paths line up.
  // Apps Script has no built-in URL constructor, so this is done with plain string methods.
  let path = rawUrl;
  if (path.indexOf('http://') === 0 || path.indexOf('https://') === 0) {
    path = path.replace(/^https?:\/\//, '');       // strip the protocol
    const slashIndex = path.indexOf('/');
    path = slashIndex === -1 ? '/' : path.substring(slashIndex); // strip the domain, keep everything from the first slash on
  }
  return path.replace(/\/$/, '').toLowerCase();
}

function combineData(months, gscData, ga4Data) {
  const allUrls = new Set();
  months.forEach(m => {
    Object.keys(gscData[m.label]).forEach(u => allUrls.add(u));
  });

  const combined = {};
  allUrls.forEach(pageUrl => {
    combined[pageUrl] = { impressions: [], position: [], sessions: [] };
    months.forEach(m => {
      const gsc = gscData[m.label][pageUrl];
      const ga4 = ga4Data[m.label][pageUrl];
      combined[pageUrl].impressions.push(gsc ? gsc.impressions : 0);
      combined[pageUrl].position.push(gsc ? gsc.position : null);
      combined[pageUrl].sessions.push(ga4 ? ga4.sessions : 0);
    });
  });
  return combined;
}

function findDecliningBlogs(combined) {
  const flagged = [];

  Object.keys(combined).forEach(pageUrl => {
    const d = combined[pageUrl];
    const [impM1, impM2, impM3] = d.impressions;
    const [sesM1, sesM2, sesM3] = d.sessions;
    const [posM1, posM2, posM3] = d.position;

    if (posM1 === null || posM2 === null || posM3 === null) return; // missing position data is skipped

    const impDeclinePct = impM1 > 0 ? (impM1 - impM3) / impM1 : 0;
    const sesDeclinePct = sesM1 > 0 ? (sesM1 - sesM3) / sesM1 : 0;
    const posDecline = posM3 - posM1; // a higher position number means a worse ranking

    const monotonicImp = impM1 > impM2 && impM2 > impM3;
    const monotonicSes = sesM1 > sesM2 && sesM2 > sesM3;
    const monotonicPos = posM1 < posM2 && posM2 < posM3;

    // each metric is checked against its own threshold, and its own trend requirement if REQUIRE_MONOTONIC is on.
    // a blog qualifies if any one of the three metrics on its own meets the bar, rather than needing all three.
    const impQualifies = impDeclinePct >= CONFIG.IMPRESSIONS_DECLINE_PCT && (!CONFIG.REQUIRE_MONOTONIC || monotonicImp);
    const sesQualifies = sesDeclinePct >= CONFIG.TRAFFIC_DECLINE_PCT && (!CONFIG.REQUIRE_MONOTONIC || monotonicSes);
    const posQualifies = posDecline >= CONFIG.POSITION_DECLINE && (!CONFIG.REQUIRE_MONOTONIC || monotonicPos);

    if (impQualifies || sesQualifies || posQualifies) {
      const reasons = [];
      if (impQualifies) reasons.push('impressions');
      if (sesQualifies) reasons.push('sessions');
      if (posQualifies) reasons.push('position');

      flagged.push({
        url: pageUrl,
        impressions: [impM1, impM2, impM3],
        sessions: [sesM1, sesM2, sesM3],
        position: [posM1, posM2, posM3],
        impDeclinePct: impDeclinePct,
        sesDeclinePct: sesDeclinePct,
        posDecline: posDecline,
        reasons: reasons,
        sessionsLost: sesM1 - sesM3,       // absolute traffic lost, used for ranking
        impressionsLost: impM1 - impM3
      });
    }
  });

  // rank by number of metrics triggered first (a blog failing on all 3 is more urgent
  // than one failing on just 1), then by absolute sessions lost as the tiebreaker,
  // since real visitors lost matters more than the percentage for deciding where to spend time.
  return flagged.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return b.sessionsLost - a.sessionsLost;
  });
}

function sendSlackAlert(flagged, months, totalQualified) {
  const monthLabels = months.map(m => m.label).join(' -> ');
  let text = '*Blogs with declining performance (' + monthLabels + ')*\n\n';

  flagged.forEach(item => {
    text += '• *' + item.url + '*  _(flagged on: ' + item.reasons.join(', ') + ')_\n';
    text += '   impressions: ' + item.impressions.join(' -> ') + ' (down ' + (item.impDeclinePct * 100).toFixed(0) + '%)\n';
    text += '   sessions: ' + item.sessions.join(' -> ') + ' (down ' + (item.sesDeclinePct * 100).toFixed(0) + '%)\n';
    text += '   position: ' + item.position.map(p => p.toFixed(1)).join(' -> ') + ' (worse by ' + item.posDecline.toFixed(1) + ')\n\n';
  });

  UrlFetchApp.fetch(CONFIG.SLACK_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text })
  });
}

function createMonthlyTrigger() {
  // run this once manually from the Apps Script editor to schedule the monthly check
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkDecliningBlogs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkDecliningBlogs')
    .timeBased()
    .onMonthDay(1)
    .atHour(8)
    .create();
}

function debugOneBlog() {
  // Change this to the exact path you want to inspect, e.g. '/blog/example-post'
  const targetPath = '/blog/example-post';

  const months = getLastThreeCompleteMonths();
  Logger.log('Checking months (oldest to newest): ' + months.map(m => m.label + ' [' + m.start + ' to ' + m.end + ']').join(', '));

  months.forEach(m => {
    const gscUrl = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(CONFIG.GSC_SITE_URL) + '/searchAnalytics/query';
    const gscPayload = { startDate: m.start, endDate: m.end, dimensions: ['page'], rowLimit: 5000 };
    const gscResponse = UrlFetchApp.fetch(gscUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(gscPayload),
      muteHttpExceptions: true
    });
    Logger.log(m.label + ' GSC status: ' + gscResponse.getResponseCode());
    if (gscResponse.getResponseCode() !== 200) {
      Logger.log(m.label + ' GSC error body: ' + gscResponse.getContentText());
    } else {
      const gscJson = JSON.parse(gscResponse.getContentText());
      const rows = gscJson.rows || [];
      Logger.log(m.label + ' GSC total rows returned: ' + rows.length);
      const sample = rows.slice(0, 5).map(r => r.keys[0]);
      Logger.log(m.label + ' GSC sample urls: ' + JSON.stringify(sample));
      const containingTarget = rows.filter(r => r.keys[0].toLowerCase().indexOf(targetPath) !== -1).map(r => r.keys[0]);
      Logger.log(m.label + ' GSC urls containing target path: ' + JSON.stringify(containingTarget));
      const match = rows.find(r => normalizeUrl(r.keys[0]) === normalizeUrl(targetPath));
      Logger.log(m.label + ' GSC row for target: ' + JSON.stringify(match || 'not found'));
    }

    const ga4Url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + CONFIG.GA4_PROPERTY_ID + ':runReport';
    const ga4Payload = { dateRanges: [{ startDate: m.start, endDate: m.end }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'sessions' }], limit: 10000 };
    const ga4Response = UrlFetchApp.fetch(ga4Url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(ga4Payload),
      muteHttpExceptions: true
    });
    Logger.log(m.label + ' GA4 status: ' + ga4Response.getResponseCode());
    if (ga4Response.getResponseCode() !== 200) {
      Logger.log(m.label + ' GA4 error body: ' + ga4Response.getContentText());
    } else {
      const ga4Json = JSON.parse(ga4Response.getContentText());
      const match = (ga4Json.rows || []).find(r => normalizeUrl(r.dimensionValues[0].value) === normalizeUrl(targetPath));
      Logger.log(m.label + ' GA4 row for target: ' + JSON.stringify(match || 'not found'));
    }
  });
}

function validateConfig() {
  const required = ['GSC_SITE_URL', 'GA4_PROPERTY_ID', 'SLACK_WEBHOOK_URL'];
  const missing = required.filter(key => !CONFIG[key]);
  if (missing.length) throw new Error('Missing Script Properties: ' + missing.join(', '));
}
