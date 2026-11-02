"""Prépare data.json pour l'appli web « Mon bus » à partir du GTFS Citéa.

    python -I build_data.py [gtfs.zip]

Sans argument, le GTFS est téléchargé. À relancer quand Citéa publie de nouveaux horaires
(le fichier actuel couvre nov. 2026 – juin 2027).
"""
import csv
import io
import json
import math
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

GTFS_URL = "https://www.data.gouv.fr/api/1/datasets/r/46bf6b5c-68c1-4198-a982-caeee88540a3"
FROM, TO = "VALENCE POLE BUS", "POLE BRIFFAUT"
OUT = Path(__file__).with_name("data.json")


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))


def secs(hms):
    h, m, *s = (int(x) for x in hms.strip().split(":"))
    return h * 3600 + m * 60 + (s[0] if s else 0)


def simplify(pts, tol):
    """Douglas-Peucker sur (lat, lon), tolérance en degrés."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    k = math.cos(math.radians(pts[0][0]))
    while stack:
        a, b = stack.pop()
        (y1, x1), (y2, x2) = pts[a], pts[b]
        dx, dy = (x2 - x1) * k, y2 - y1
        n = math.hypot(dx, dy) or 1e-12
        best, idx = 0, -1
        for i in range(a + 1, b):
            y, x = pts[i]
            d = abs(dy * (x - x1) * k - dx * (y - y1)) / n
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, f in zip(pts, keep) if f]


def main():
    if len(sys.argv) > 1:
        data = Path(sys.argv[1]).read_bytes()
    else:
        req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "MonBus"})
        data = urllib.request.urlopen(req, timeout=120).read()
    z = zipfile.ZipFile(io.BytesIO(data))

    origin, dest, pos = set(), set(), {FROM: [], TO: []}
    for r in rows(z, "stops.txt"):
        n = r["stop_name"].strip().upper()
        if n in pos:
            (origin if n == FROM else dest).add(r["stop_id"])
            pos[n].append((float(r["stop_lat"]), float(r["stop_lon"])))
    centre = {k: [round(sum(p[0] for p in v) / len(v), 6), round(sum(p[1] for p in v) / len(v), 6)] for k, v in pos.items()}

    routes = {r["route_id"]: [r["route_short_name"] or r["route_id"], r.get("route_color") or "000000",
                              r.get("route_text_color") or "FFFFFF"] for r in rows(z, "routes.txt")}
    trips = {r["trip_id"]: (r["route_id"], r["service_id"], r.get("shape_id", "")) for r in rows(z, "trips.txt")}

    o_hit, d_hit = {}, defaultdict(list)
    for r in rows(z, "stop_times.txt"):
        s = r["stop_id"]
        if s not in origin and s not in dest:
            continue
        t, seq = r["trip_id"], int(r["stop_sequence"])
        if s in origin and (t not in o_hit or seq < o_hit[t][1]):
            o_hit[t] = (secs(r["departure_time"] or r["arrival_time"]), seq, s)
        if s in dest:
            d_hit[t].append((secs(r["arrival_time"] or r["departure_time"]), seq))

    deps, used = [], set()
    for t, (dep, seq, stop) in o_hit.items():
        after = [d for d in d_hit.get(t, []) if d[1] > seq]
        if not after or t not in trips:
            continue
        arr, aseq = min(after, key=lambda d: d[1])
        route, service, _ = trips[t]
        used.add(route)
        deps.append([t, service, routes[route][0], stop, dep, arr, seq, aseq])
    deps.sort(key=lambda d: d[4])

    weekly = []
    if "calendar.txt" in z.namelist():
        days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        weekly = [[r["service_id"], "".join(r[d] for d in days), int(r["start_date"]), int(r["end_date"])]
                  for r in rows(z, "calendar.txt")]
    added, removed = defaultdict(list), defaultdict(list)
    if "calendar_dates.txt" in z.namelist():
        for r in rows(z, "calendar_dates.txt"):
            (removed if r["exception_type"].strip() == "2" else added)[r["date"]].append(r["service_id"])

    shape_route = {sh: rt for rt, _, sh in trips.values() if rt in used and sh}
    pts = defaultdict(list)
    for r in rows(z, "shapes.txt"):
        if r["shape_id"] in shape_route:
            pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    shapes = []
    for sh, p in pts.items():
        p.sort()
        line = simplify([(a, b) for _, a, b in p], 0.00004)
        shapes.append({"line": routes[shape_route[sh]][0],
                       "pts": [[round(a, 5), round(b, 5)] for a, b in line]})

    out = {
        "from": {"name": FROM, "label": "Pôle Bus", "pos": centre[FROM]},
        "to": {"name": TO, "label": "Briffaut", "pos": centre[TO]},
        "routes": {k: v for k, v in routes.items() if k in used},
        "weekly": weekly, "added": added, "removed": removed,
        "deps": deps, "shapes": shapes,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), "utf-8")
    print(f"{OUT.name} : {len(deps)} passages, {len(shapes)} tracés, {OUT.stat().st_size // 1024} Ko")


if __name__ == "__main__":
    main()
