"""Two-way sync of the grocery list with a Home Assistant To-do entity.

Chain: Alice's shopping list <-> Yandex.Station integration <-> todo.* in HA <-> Homeledger.
The Yandex.Station integration (AlexxIT) syncs Alice with a To-do entity when asked via
media_player.play_media(media_content_type=shopping_list, media_content_id=<todo entity>),
so we ask it before reading the list and again after we changed it.

db["todo_sync"]["links"] maps a To-do item uid to {"gid": grocery id, "summary": text last seen on
both sides}; comparing against it tells which side added, removed or renamed an item.
"""

import threading
import time
from datetime import datetime

import ha
import logic
from i18n import tr

state = {"last_sync": None, "last_error": None, "in_added": 0, "in_removed": 0, "out_added": 0, "out_removed": 0}
_running = threading.Lock()
STATION_SETTLE_SECONDS = 3


def summary(g):
    qty = str(g.get("qty") or "").strip()
    return g.get("name", "").strip() + (f" {qty}" if qty else "")


def category_for(db, name):
    n = name.strip().lower()
    for trip in reversed(db["trips"]):
        for item in trip["items"]:
            if item.get("name", "").strip().lower() == n and item.get("category"):
                return item["category"]
    return tr("fallback.other")


def fetch_items(entity):
    resp = ha.client.call("POST", "/services/todo/get_items?return_response", {"entity_id": entity})
    data = resp.get("service_response", resp) if isinstance(resp, dict) else {}
    return (data.get(entity) or {}).get("items", [])


def ask_station(station, entity):
    ha.client.call("POST", "/services/media_player/play_media", {
        "entity_id": station, "media_content_type": "shopping_list", "media_content_id": entity})


def reconcile(db, entity, items):
    """Apply changes made in HA to db; return the changes HA still has to receive."""
    sync = db.setdefault("todo_sync", {})
    if sync.get("entity") != entity:
        sync.clear()
        sync.update(entity=entity, links={})
    links = sync["links"]
    by_uid = {i["uid"]: i for i in items if i.get("uid")}
    groceries = {g["id"]: g for g in db["groceries"]}
    ops, counts = [], {"in_added": 0, "in_removed": 0}
    handled = set()  # uids settled above; they must not look "new" below

    for uid, link in list(links.items()):
        g, item = groceries.get(link["gid"]), by_uid.get(uid)
        is_open = bool(item) and item.get("status") == "needs_action"
        handled.add(uid)
        if g is None:  # removed or bought in Homeledger
            if is_open:
                ops.append(("complete", uid, None))
            del links[uid]
        elif not is_open:  # checked off or deleted in HA / by voice
            db["groceries"].remove(g)
            groceries.pop(g["id"])
            del links[uid]
            counts["in_removed"] += 1
        elif item["summary"] != link["summary"]:  # renamed in HA
            g["name"], g["qty"] = item["summary"].strip(), ""
            link["summary"] = item["summary"]
        elif summary(g) != link["summary"]:  # renamed in Homeledger
            ops.append(("rename", uid, summary(g)))
            link["summary"] = summary(g)

    linked = {link["gid"] for link in links.values()}
    for item in items:
        if item.get("status") != "needs_action" or item.get("uid") in handled or not item.get("uid"):
            continue
        name = item["summary"].strip()
        g = next((g for g in db["groceries"] if g["id"] not in linked
                  and name.lower() in (summary(g).lower(), g["name"].strip().lower())), None)
        if g is None:
            g = {"id": logic.new_id(), "name": name, "qty": "", "category": category_for(db, name),
                 "added_by": None, "source": "todo", "created_at": datetime.now().isoformat(timespec="seconds")}
            db["groceries"].append(g)
            counts["in_added"] += 1
        links[item["uid"]] = {"gid": g["id"], "summary": item["summary"]}
        linked.add(g["id"])

    for g in db["groceries"]:
        if g["id"] not in linked:
            ops.append(("add", g["id"], summary(g)))
    return ops, counts


def sync(load, save, lock):
    """Run one sync round. Returns None when sync isn't configured."""
    with lock:
        settings = load()["settings"]
    entity, station = settings.get("todo_entity"), settings.get("yandex_station")
    if not entity or not ha.client.available:
        return None
    if not _running.acquire(blocking=False):
        return state  # another round is in progress
    try:
        if station:
            ask_station(station, entity)
            time.sleep(STATION_SETTLE_SECONDS)
        items = fetch_items(entity)
        with lock:
            db = load()
            ops, counts = reconcile(db, entity, items)
            save(db)

        for op, key, text in ops:
            if op == "add":
                ha.client.call("POST", "/services/todo/add_item", {"entity_id": entity, "item": text})
            elif op == "complete":
                ha.client.call("POST", "/services/todo/update_item", {"entity_id": entity, "item": key, "status": "completed"})
            elif op == "rename":
                ha.client.call("POST", "/services/todo/update_item", {"entity_id": entity, "item": key, "rename": text})

        added = {(key, text) for op, key, text in ops if op == "add"}
        if added:  # learn the uids HA gave to the items we just added
            fresh = fetch_items(entity)
            with lock:
                db = load()
                links = db["todo_sync"]["links"]
                existing = {g["id"] for g in db["groceries"]}
                for gid, text in added:
                    item = next((i for i in fresh if i.get("status") == "needs_action" and i.get("uid") not in links
                                 and i["summary"].strip().lower() == text.strip().lower()), None)
                    if item and gid in existing:
                        links[item["uid"]] = {"gid": gid, "summary": item["summary"]}
                save(db)
        if ops and station:
            ask_station(station, entity)

        state.update(last_sync=datetime.now().isoformat(timespec="seconds"), last_error=None)
        state["in_added"] += counts["in_added"]
        state["in_removed"] += counts["in_removed"]
        state["out_added"] += len(added)
        state["out_removed"] += sum(1 for op in ops if op[0] == "complete")
        return state
    except Exception as e:  # noqa: BLE001 — shown in the UI
        state["last_error"] = str(e)
        raise
    finally:
        _running.release()
