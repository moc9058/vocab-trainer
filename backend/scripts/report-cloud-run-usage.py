# Run with: .venv/bin/python backend/scripts/report-cloud-run-usage.py
"""Read-only Cloud Monitoring baseline; this is usage, not a billing invoice."""
import argparse
import datetime as dt
import json
import subprocess
import ssl
import urllib.error
import urllib.parse
import urllib.request
import certifi


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="vocab-trainer-490014")
    parser.add_argument("--region", default="asia-northeast1")
    parser.add_argument("--days", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    # Capture credentials only in memory; never print or persist the token.
    token = subprocess.check_output(
        ["gcloud", "auth", "print-access-token"], text=True,
    ).strip()
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=args.days)
    services = ["vocab-trainer-backend", "vocab-trainer-frontend"]
    tls = ssl.create_default_context(cafile=certifi.where())
    totals = {service: {} for service in services}
    endpoint = f"https://monitoring.googleapis.com/v3/projects/{urllib.parse.quote(args.project, safe='')}/timeSeries"
    for name, metric in {
        "billableInstanceSeconds": "run.googleapis.com/container/billable_instance_time",
        "requests": "run.googleapis.com/request_count",
    }.items():
        params = {
            "filter": f'metric.type="{metric}" AND resource.type="cloud_run_revision" AND resource.labels.location="{args.region}"',
            "interval.startTime": start.isoformat(),
            "interval.endTime": end.isoformat(),
            "aggregation.alignmentPeriod": "86400s",
            "aggregation.perSeriesAligner": "ALIGN_SUM",
            "aggregation.crossSeriesReducer": "REDUCE_SUM",
            "aggregation.groupByFields": "resource.labels.service_name",
            "pageSize": "1000",
        }
        values = {}
        while True:
            request = urllib.request.Request(
                endpoint + "?" + urllib.parse.urlencode(params),
                headers={"Authorization": "Bearer " + token},
            )
            with urllib.request.urlopen(request, timeout=60, context=tls) as response:
                data = json.load(response)
            for series in data.get("timeSeries", []):
                service = series["resource"]["labels"]["service_name"]
                if service not in totals:
                    continue
                values[service] = values.get(service, 0) + sum(
                    float(point["value"].get("doubleValue", point["value"].get("int64Value", 0)))
                    for point in series.get("points", [])
                )
            if not data.get("nextPageToken"):
                break
            params["pageToken"] = data["nextPageToken"]
        for service in services:
            # Missing metrics are not proof of zero usage.
            value = values.get(service)
            totals[service][name] = round(value, 3) if value is not None else None
    print(json.dumps({
        "project": args.project, "region": args.region,
        "start": start.isoformat(), "end": end.isoformat(),
        "services": totals,
        "note": "Usage only. Missing metrics are null. Compare billing SKUs separately; free tier, requests, network, Logging, Firestore and OpenAI costs are not calculated.",
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Monitoring API returned HTTP {error.code}; check API access and monitoring.timeSeries.list permission.") from None
    except urllib.error.URLError as error:
        raise SystemExit(f"Could not read usage: {error.reason}. Check network access and Python CA certificates.") from None
    except subprocess.CalledProcessError:
        raise SystemExit("Could not authenticate; check gcloud login.") from None
