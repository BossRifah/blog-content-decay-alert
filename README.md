# Blog content decay alert

A Google Apps Script marketing automation that checks the last three complete months of Google Search Console and GA4 data and sends a Slack alert when blog performance declines.

## What it checks

A page qualifies when any metric meets its threshold:

- Impressions decline by at least 15% from the first month to the third.
- Sessions decline by at least 15%.
- Average search position worsens by at least 3 spots.

By default, the qualifying metric must worsen each month. Alerts include up to seven pages, ranked by the number of qualifying metrics, then absolute sessions lost. Change thresholds and the blog path filter in `CONFIG`.

## Setup

1. Create a standalone project in Google Apps Script and paste `Code.gs` into the editor.
2. In Project Settings, show the `appsscript.json` manifest and replace it with the included manifest. Choose the project time zone for scheduling.
3. Link a Google Cloud project and enable the Google Search Console API and Google Analytics Data API.
4. In **Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `GSC_SITE_URL` | Exact Search Console property, such as `https://example.com/` or `sc-domain:example.com` |
   | `GA4_PROPERTY_ID` | Numeric GA4 property ID, without `properties/` |
   | `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |

5. Run `checkDecliningBlogs` manually and authorize access with a Google account that can read both properties. This may send an alert if pages qualify.
6. Run `createMonthlyTrigger` once to schedule checks on the first day of each month during the 8 a.m. hour in the project time zone. Running it again replaces the existing trigger for this handler.

Keep webhook credentials in Script Properties and out of Git. Anyone with edit access to the Apps Script project can access those properties. Google authorization is handled by Apps Script; no Google API keys are needed.

## Troubleshooting and limitations

- Set `targetPath` in `debugOneBlog` to inspect a page manually. Diagnostic logs can contain site and analytics data; review them before sharing.
- Pages missing Search Console position data in any month are skipped.
- Each month retrieves up to 5,000 Search Console rows and 10,000 GA4 rows; this version does not paginate.
- The main data fetches do not explicitly reject API error responses. Inspect diagnostics if results are unexpectedly empty.
- URLs are matched by lowercased path with the trailing slash removed. Query strings are retained.
- Recent Search Console data may be incomplete on the first day of the month. Adjust scheduling if needed.

The repository contains no production credentials. Live Google and Slack access is required to verify the complete workflow.
