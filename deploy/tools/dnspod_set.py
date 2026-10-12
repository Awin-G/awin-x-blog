#!/usr/bin/env python3
"""Create or update a DNSPod (Tencent Cloud) record.

Unlike the older helper on the box, this one tolerates an empty record list
(DescribeRecordList returns ResourceNotFound.NoDataOfRecord for a fresh name)
so it can CREATE the first record for a subdomain.

Usage: dnspod_set.py <subdomain> <type> <value> [ttl]
"""
import importlib.util
import sys

SSL_SCRIPT = "/root/python/ssl_auto_download/ssl_auto_download.py"
DOMAIN = "awin-x.top"


def load():
    spec = importlib.util.spec_from_file_location("sd", SSL_SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def call(m, action, params):
    return m.send_req("dnspod", "dnspod.tencentcloudapi.com", action, params, "2021-03-23")


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    name, rtype, value = sys.argv[1], sys.argv[2], sys.argv[3]
    ttl = int(sys.argv[4]) if len(sys.argv) > 4 else 600
    m = load()

    res = call(m, "DescribeRecordList", {"Domain": DOMAIN, "Subdomain": name})
    if "Error" in res and res["Error"].get("Code") != "ResourceNotFound.NoDataOfRecord":
        raise SystemExit("DescribeRecordList failed: %s" % res["Error"])
    records = res.get("RecordList") or []
    match = next((r for r in records if r["Name"] == name and r["Type"] == rtype), None)

    if match:
        out = call(m, "ModifyRecord", {
            "Domain": DOMAIN, "RecordId": int(match["RecordId"]), "SubDomain": name,
            "RecordType": rtype, "RecordLine": match.get("Line") or "默认",
            "Value": value, "TTL": ttl,
        })
        print("updated %s.%s -> %s: %s" % (name, DOMAIN, value, out.get("RecordId") or out.get("Error")))
    else:
        out = call(m, "CreateRecord", {
            "Domain": DOMAIN, "SubDomain": name, "RecordType": rtype,
            "RecordLine": "默认", "Value": value, "TTL": ttl,
        })
        print("created %s.%s -> %s: %s" % (name, DOMAIN, value, out.get("RecordId") or out.get("Error")))


if __name__ == "__main__":
    main()
